import { RipgrepFilenameDecoder } from '../../shared/ripgrep-filename-decoder'
import { isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'
import { normalizeRelativePath } from '../../shared/text-search-paths'
import {
  basename as pathBasename,
  extname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve
} from 'node:path'
import type { FileDocument, MarkdownDocument } from '../../shared/filesystem-entry-types'
import { spawnBundledRipgrep } from '../ripgrep/bundled-ripgrep-spawn'
import { parseWslPath } from '../wsl'
import {
  isRipgrepMissingCwdExit,
  ripgrepMissingCwdError
} from '../../shared/ripgrep-process-availability'
import {
  assertMarkdownDocumentPathWithinLimit,
  createMarkdownDocumentListingBudget,
  retainMarkdownDocument
} from '../../shared/markdown-document-listing-limits'

export function isMarkdownDocumentName(name: string): boolean {
  return isMarkdownExtension(extname(name))
}

function isMarkdownExtension(extension: string): boolean {
  const normalized = extension.toLowerCase()
  return normalized === '.md' || normalized === '.mdx' || normalized === '.markdown'
}

function basenameFromRelativePath(relativePath: string): string {
  return relativePath.slice(relativePath.lastIndexOf('/') + 1)
}

function isSafeRelativePath(relativePath: string): boolean {
  return !relativePath.split('/').includes('..')
}

function rootRelativePath(rootPath: string, filePath: string): string | null {
  const resolvedRoot = resolve(rootPath)
  const resolvedFile = resolve(filePath)
  const relativePath = relative(resolvedRoot, resolvedFile)
  if (
    !isSafeRelativePath(normalizeRelativePath(relativePath, rootPath)) ||
    isAbsolute(relativePath)
  ) {
    return null
  }
  return normalizeRelativePath(relativePath, rootPath)
}

export function fileDocumentFromFilePath(
  rootPath: string,
  filePath: string,
  options: { outsideRootRelativePath?: 'basename' | 'relative' } = {}
): FileDocument {
  const basename = pathBasename(filePath)
  const extension = extname(basename)
  const relativePath =
    rootRelativePath(rootPath, filePath) ??
    (options.outsideRootRelativePath === 'basename'
      ? basename
      : normalizeRelativePath(relative(rootPath, filePath), rootPath))
  return {
    filePath,
    relativePath,
    basename,
    name: extension ? basename.slice(0, -extension.length) : basename
  }
}

export const markdownDocumentFromFilePath = fileDocumentFromFilePath

export function markdownDocumentFromRelativePath(
  rootPath: string,
  relativePath: string
): MarkdownDocument | null {
  const normalizedRelativePath = normalizeRelativePath(relativePath, rootPath)
  // Why: SSH providers should return root-relative paths; reject escape
  // segments before building a synthetic absolute path for renderer use.
  if (!isSafeRelativePath(normalizedRelativePath)) {
    return null
  }
  const basename = basenameFromRelativePath(normalizedRelativePath)
  // Remote separators are already normalized; a POSIX backslash stays part of the name.
  const extension = posix.extname(basename)
  if (!isMarkdownExtension(extension)) {
    return null
  }
  const normalizedRoot = rootPath.replace(
    isWindowsAbsolutePathLike(rootPath) ? /[\\/]+$/ : /\/+$/,
    ''
  )
  return {
    filePath: `${normalizedRoot}/${normalizedRelativePath}`,
    relativePath: normalizedRelativePath,
    basename,
    name: extension ? basename.slice(0, -extension.length) : basename
  }
}

export function markdownDocumentsFromRelativePaths(
  rootPath: string,
  relativePaths: string[]
): MarkdownDocument[] {
  const budget = createMarkdownDocumentListingBudget()
  const documents: MarkdownDocument[] = []
  for (const relativePath of relativePaths) {
    const document = markdownDocumentFromRelativePath(rootPath, relativePath)
    if (document) {
      retainMarkdownDocument(budget, document)
      documents.push(document)
    }
  }
  return documents.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
}

const MARKDOWN_LISTING_TIMEOUT_MS = 15_000

export async function listMarkdownDocuments(
  rootPath: string,
  options: { wslDistro?: string } = {}
): Promise<MarkdownDocument[]> {
  const budget = createMarkdownDocumentListingBudget()
  assertMarkdownDocumentPathWithinLimit(rootPath)
  const child = spawnBundledRipgrep(
    [
      '--files',
      '--hidden',
      '--no-ignore',
      '--no-config',
      '--null',
      '--path-separator',
      '/',
      // Keep case variants in --glob: --iglob is applied after exclusions and can reopen hidden folders.
      '--glob',
      '*.{[mM][dD],[mM][dD][xX],[mM][aA][rR][kK][dD][oO][wW][nN]}',
      '--glob',
      '!**/.*/',
      '--glob',
      '**/.github/',
      '--glob',
      '!**/node_modules/',
      '.'
    ],
    {
      cwd: rootPath,
      wslDistro: options.wslDistro,
      wslDistroForOutput: parseWslPath(rootPath)?.distro ?? options.wslDistro,
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )

  return new Promise((resolveListing, reject) => {
    const filenameDecoder = new RipgrepFilenameDecoder(
      (error) => finish(error),
      Boolean(parseWslPath(rootPath)?.distro ?? options.wslDistro)
    )
    const documents: MarkdownDocument[] = []
    let carry = ''
    let stderr = ''
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      child.stdout?.off('data', onData)
      child.stderr?.off('data', onStderr)
      child.stdout?.off('error', onError)
      child.stderr?.off('error', onError)
      child.off('close', onClose)
      child.off('error', onError)
      // A spawn or pipe error can arrive after a timeout has already settled the listing.
      child.on('error', ignoreLateError)
      child.stdout?.on('error', ignoreLateError)
      child.stderr?.on('error', ignoreLateError)
      carry = ''
      if (error) {
        if (child.pid !== undefined) {
          try {
            child.kill('SIGKILL')
          } catch {
            // The process may have exited before the timeout or stream error arrived.
          }
        }
        documents.length = 0
        child.stdout?.resume()
        child.stderr?.resume()
        reject(error)
      } else {
        resolveListing(documents.sort((a, b) => a.relativePath.localeCompare(b.relativePath)))
      }
    }
    const onError = (error: Error): void => finish(error)
    const onStderr = (chunk: string): void => {
      stderr = (stderr + chunk).slice(0, 4096)
    }
    const onData = (chunk: Buffer | string): void => {
      try {
        const decoded = filenameDecoder.decode(chunk)
        if (decoded === null) {
          return
        }
        carry += decoded
        let start = 0
        let end: number
        while ((end = carry.indexOf('\0', start)) !== -1) {
          const path = carry.slice(start, end)
          assertMarkdownDocumentPathWithinLimit(path)
          if (!path.startsWith('./') || path.split('/').includes('..')) {
            finish(new Error('Invalid path in Markdown document listing'))
            return
          }
          if (isMarkdownDocumentName(path)) {
            const document = markdownDocumentFromFilePath(rootPath, join(rootPath, path.slice(2)))
            retainMarkdownDocument(budget, document)
            documents.push(document)
          }
          start = end + 1
        }
        carry = carry.slice(start)
        assertMarkdownDocumentPathWithinLimit(carry)
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    }
    const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (isRipgrepMissingCwdExit(code)) {
        finish(ripgrepMissingCwdError(rootPath))
      } else if (signal || (code !== 0 && code !== 1)) {
        finish(new Error(`Markdown document listing failed (${signal ?? code}): ${stderr.trim()}`))
      } else {
        if (!filenameDecoder.finish()) {
          return
        }
        finish(carry ? new Error('Incomplete path in Markdown document listing') : undefined)
      }
    }
    const timer = setTimeout(
      () => finish(new Error('Markdown document listing timed out')),
      MARKDOWN_LISTING_TIMEOUT_MS
    )
    timer.unref?.()
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onStderr)
    child.stdout?.on('error', onError)
    child.stderr?.on('error', onError)
    child.once('error', onError)
    child.once('close', onClose)
  })
}

function ignoreLateError(): void {}

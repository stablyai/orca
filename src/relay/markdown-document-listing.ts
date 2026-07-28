import { spawn, type ChildProcess } from 'node:child_process'
import { checkRgAvailable } from './fs-handler-utils'
import {
  buildRgArgsForQuickOpen,
  normalizeQuickOpenRgLine,
  shouldIncludeQuickOpenPath
} from '../shared/quick-open-filter'
import {
  assertMarkdownDocumentPathWithinLimit,
  createMarkdownDocumentListingBudget,
  isMarkdownDocumentListingCapacityError,
  MARKDOWN_DOCUMENT_LISTING_ERROR_MESSAGE,
  MARKDOWN_DOCUMENT_LISTING_MAX_PATH_BYTES,
  MarkdownDocumentListingCapacityError,
  retainMarkdownRelativePath,
  visitMarkdownDocumentListingEntry
} from '../shared/markdown-document-listing-limits'
import {
  discoverMarkdownRelativePaths,
  isMarkdownDocumentPath
} from '../shared/node-markdown-document-discovery'
import { fileListingCancellationError } from '../shared/file-listing-cancellation'
import { RelayErrorCode } from './protocol'
import { GrowingByteBuffer } from '../shared/growing-byte-buffer'

const MARKDOWN_LISTING_TIMEOUT_MS = 25_000
const MARKDOWN_GLOBS = ['*.md', '*.mdx', '*.markdown']

class MarkdownPathFieldAccumulator {
  private readonly field = new GrowingByteBuffer()

  push(chunk: Buffer, onPath: (path: string) => void): boolean {
    let cursor = 0
    while (cursor < chunk.length) {
      const delimiter = chunk.indexOf(0, cursor)
      const end = delimiter === -1 ? chunk.length : delimiter
      const segmentBytes = end - cursor
      if (this.field.byteLength + segmentBytes > MARKDOWN_DOCUMENT_LISTING_MAX_PATH_BYTES) {
        this.clear()
        return false
      }
      if (delimiter !== -1 && this.field.byteLength === 0) {
        onPath(chunk.toString('utf8', cursor, end))
      } else if (segmentBytes > 0) {
        this.field.append(chunk.subarray(cursor, end))
        if (delimiter !== -1) {
          onPath(this.take())
        }
      } else if (delimiter !== -1) {
        onPath(this.take())
      }
      if (delimiter === -1) {
        return true
      }
      cursor = delimiter + 1
    }
    return true
  }

  finish(): string | null {
    return this.field.byteLength > 0 ? this.take() : null
  }

  private take(): string {
    return this.field.takeString()
  }

  private clear(): void {
    this.field.clear()
  }
}

function markdownRgArgs(args: string[]): string[] {
  const target = args.at(-1)
  if (!target) {
    throw new Error('Markdown rg scan is missing its search root')
  }
  const result = [...args.slice(0, -1), '--null']
  for (const glob of MARKDOWN_GLOBS) {
    result.push('--iglob', glob)
  }
  result.push(target)
  return result
}

function relativePathDepth(path: string): number {
  let depth = 0
  for (let index = 0; index < path.length; index += 1) {
    if (path[index] === '/') {
      depth += 1
    }
  }
  return depth
}

export async function listMarkdownPathsWithRg(
  rootPath: string,
  signal?: AbortSignal,
  spawnProcess: (args: string[]) => ChildProcess = (args) =>
    spawn('rg', args, { cwd: rootPath, stdio: ['ignore', 'pipe', 'pipe'] })
): Promise<string[]> {
  const paths = new Set<string>()
  const budget = createMarkdownDocumentListingBudget()
  assertMarkdownDocumentPathWithinLimit(rootPath, budget.limits.maxPathBytes)
  const passes = buildRgArgsForQuickOpen({
    searchRoot: '.',
    excludePathPrefixes: [],
    forceSlashSeparator: true
  })

  const runPass = (args: string[]): Promise<void> =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(fileListingCancellationError(signal))
        return
      }
      const child = spawnProcess(markdownRgArgs(args))
      const fields = new MarkdownPathFieldAccumulator()
      let done = false
      let parseablePathCount = 0
      let timer: ReturnType<typeof setTimeout> | null = null

      const cleanup = (): void => {
        if (timer) {
          clearTimeout(timer)
          timer = null
        }
        child.stdout?.off('data', onStdout)
        child.stderr?.off('data', onStderr)
        child.off('error', onError)
        child.off('close', onClose)
        signal?.removeEventListener('abort', onAbort)
      }
      const finish = (error?: Error, kill = false): void => {
        if (done) {
          return
        }
        done = true
        cleanup()
        if (kill && child.exitCode === null && child.signalCode === null) {
          child.kill()
        }
        if (error) {
          reject(error)
        } else {
          resolve()
        }
      }
      const processPath = (rawPath: string): void => {
        const relativePath = normalizeQuickOpenRgLine(rawPath, { kind: 'cwd-relative' })
        if (relativePath === null) {
          return
        }
        parseablePathCount += 1
        if (
          paths.has(relativePath) ||
          !shouldIncludeQuickOpenPath(relativePath) ||
          !isMarkdownDocumentPath(relativePath)
        ) {
          return
        }
        visitMarkdownDocumentListingEntry(budget, relativePath, relativePathDepth(relativePath))
        retainMarkdownRelativePath(budget, rootPath, relativePath)
        paths.add(relativePath)
      }
      const onStdout = (chunk: Buffer): void => {
        try {
          if (!fields.push(chunk, processPath)) {
            finish(new MarkdownDocumentListingCapacityError(), true)
          }
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)), true)
        }
      }
      const onStderr = (): void => {}
      const onError = (error: Error): void => finish(error)
      const onClose = (code: number | null, exitSignal: NodeJS.Signals | null): void => {
        if (exitSignal) {
          finish(new Error(`rg killed by ${exitSignal}`))
          return
        }
        try {
          const trailingPath = fields.finish()
          if (trailingPath !== null) {
            processPath(trailingPath)
          }
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)))
          return
        }
        if (code === 0 || code === 1 || (code === 2 && parseablePathCount > 0)) {
          finish()
        } else {
          finish(new Error(`rg exited with code ${code}`))
        }
      }
      const onAbort = (): void => finish(fileListingCancellationError(signal), true)

      child.stdout?.on('data', onStdout)
      child.stderr?.on('data', onStderr)
      child.once('error', onError)
      child.once('close', onClose)
      signal?.addEventListener('abort', onAbort, { once: true })
      timer = setTimeout(
        () => finish(new Error('Markdown document listing timed out'), true),
        MARKDOWN_LISTING_TIMEOUT_MS
      )
    })

  await runPass(passes.primary)
  await runPass(passes.ignoredPass)
  return Array.from(paths)
}

export async function listRelayMarkdownDocumentPaths(
  rootPath: string,
  signal?: AbortSignal
): Promise<string[]> {
  try {
    if (await checkRgAvailable()) {
      return await listMarkdownPathsWithRg(rootPath, signal)
    }
    return await discoverMarkdownRelativePaths(rootPath, {
      ignoreNestedDirectoryErrors: true,
      shouldDescend: (relativePath) => shouldIncludeQuickOpenPath(relativePath),
      signal
    })
  } catch (error) {
    if (!isMarkdownDocumentListingCapacityError(error)) {
      throw error
    }
    const relayError = new Error(MARKDOWN_DOCUMENT_LISTING_ERROR_MESSAGE) as Error & {
      code: number
    }
    relayError.code = RelayErrorCode.MarkdownDocumentListingCapacity
    throw relayError
  }
}

import { readdir } from 'fs/promises'
import { basename as pathBasename, extname, join, relative } from 'path'
import type { MarkdownDocument } from '../../shared/types'

function normalizeRelativePath(path: string): string {
  return path.replace(/[\\/]+/g, '/').replace(/^\/+/, '')
}

function isMarkdownDocumentName(name: string): boolean {
  const extension = extname(name).toLowerCase()
  return extension === '.md' || extension === '.mdx' || extension === '.markdown'
}

function basenameFromRelativePath(relativePath: string): string {
  const normalizedPath = relativePath.replaceAll('\\', '/')
  return normalizedPath.slice(normalizedPath.lastIndexOf('/') + 1)
}

function isSafeRelativePath(relativePath: string): boolean {
  return !relativePath.split('/').includes('..')
}

function toMarkdownDocument(rootPath: string, filePath: string): MarkdownDocument {
  const basename = pathBasename(filePath)
  const extension = extname(basename)
  return {
    filePath,
    relativePath: normalizeRelativePath(relative(rootPath, filePath)),
    basename,
    name: extension ? basename.slice(0, -extension.length) : basename
  }
}

export function markdownDocumentFromRelativePath(
  rootPath: string,
  relativePath: string
): MarkdownDocument | null {
  const normalizedRelativePath = normalizeRelativePath(relativePath)
  // Why: SSH providers should return root-relative paths; reject escape
  // segments before building a synthetic absolute path for renderer use.
  if (!isSafeRelativePath(normalizedRelativePath)) {
    return null
  }
  const basename = basenameFromRelativePath(normalizedRelativePath)
  if (!isMarkdownDocumentName(basename)) {
    return null
  }
  const extension = extname(basename)
  const normalizedRoot = rootPath.replace(/[\\/]+$/, '')
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
  return relativePaths
    .map((relativePath) => markdownDocumentFromRelativePath(rootPath, relativePath))
    .filter((document): document is MarkdownDocument => document !== null)
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath))
}

export async function listMarkdownDocuments(rootPath: string): Promise<MarkdownDocument[]> {
  const documents: MarkdownDocument[] = []

  async function visitDirectory(dirPath: string): Promise<void> {
    const entries = await readdir(dirPath, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue
      }

      const entryPath = join(dirPath, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === '.git' || entry.name === 'node_modules') {
          continue
        }
        if (entry.name.startsWith('.') && entry.name !== '.github') {
          continue
        }
        await visitDirectory(entryPath)
        continue
      }

      if (entry.isFile() && isMarkdownDocumentName(entry.name)) {
        documents.push(toMarkdownDocument(rootPath, entryPath))
      }
    }
  }

  await visitDirectory(rootPath)
  return documents.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
}

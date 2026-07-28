import { basename as pathBasename, extname, isAbsolute, relative, resolve } from 'node:path'
import type { MarkdownDocument } from '../../shared/types'
import {
  assertMarkdownDocumentPathWithinLimit,
  createMarkdownDocumentListingBudget,
  retainMarkdownDocument,
  type MarkdownDocumentListingLimits
} from '../../shared/markdown-document-listing-limits'
import {
  discoverMarkdownRelativePaths,
  isMarkdownDocumentPath
} from '../../shared/node-markdown-document-discovery'

function normalizeRelativePath(path: string): string {
  return path.replace(/[\\/]+/g, '/').replace(/^\/+/, '')
}

export function isMarkdownDocumentName(name: string): boolean {
  return isMarkdownDocumentPath(name)
}

function basenameFromRelativePath(relativePath: string): string {
  const normalizedPath = relativePath.replaceAll('\\', '/')
  return normalizedPath.slice(normalizedPath.lastIndexOf('/') + 1)
}

function isSafeRelativePath(relativePath: string): boolean {
  return !relativePath.split('/').includes('..')
}

function hasParentTraversalSegment(relativePath: string): boolean {
  return relativePath.split(/[\\/]+/).includes('..')
}

function rootRelativePath(rootPath: string, filePath: string): string | null {
  const resolvedRoot = resolve(rootPath)
  const resolvedFile = resolve(filePath)
  const relativePath = relative(resolvedRoot, resolvedFile)
  if (hasParentTraversalSegment(relativePath) || isAbsolute(relativePath)) {
    return null
  }
  return normalizeRelativePath(relativePath)
}

export function markdownDocumentFromFilePath(
  rootPath: string,
  filePath: string,
  options: { outsideRootRelativePath?: 'basename' | 'relative' } = {}
): MarkdownDocument {
  assertMarkdownDocumentPathWithinLimit(rootPath)
  assertMarkdownDocumentPathWithinLimit(filePath)
  const basename = pathBasename(filePath)
  const extension = extname(basename)
  const relativePath =
    rootRelativePath(rootPath, filePath) ??
    (options.outsideRootRelativePath === 'basename'
      ? basename
      : normalizeRelativePath(relative(rootPath, filePath)))
  const document = {
    filePath,
    relativePath,
    basename,
    name: extension ? basename.slice(0, -extension.length) : basename
  }
  const budget = createMarkdownDocumentListingBudget()
  retainMarkdownDocument(budget, document)
  return document
}

export function markdownDocumentFromRelativePath(
  rootPath: string,
  relativePath: string
): MarkdownDocument | null {
  assertMarkdownDocumentPathWithinLimit(rootPath)
  assertMarkdownDocumentPathWithinLimit(relativePath)
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
  const document = {
    filePath: `${normalizedRoot}/${normalizedRelativePath}`,
    relativePath: normalizedRelativePath,
    basename,
    name: extension ? basename.slice(0, -extension.length) : basename
  }
  const budget = createMarkdownDocumentListingBudget()
  retainMarkdownDocument(budget, document)
  return document
}

export function markdownDocumentsFromRelativePaths(
  rootPath: string,
  relativePaths: readonly string[],
  limits: Partial<MarkdownDocumentListingLimits> = {}
): MarkdownDocument[] {
  const budget = createMarkdownDocumentListingBudget(limits)
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

export async function listMarkdownDocuments(
  rootPath: string,
  limits: Partial<MarkdownDocumentListingLimits> = {}
): Promise<MarkdownDocument[]> {
  const relativePaths = await discoverMarkdownRelativePaths(rootPath, {
    limits,
    shouldDescend: (_relativePath, name) =>
      name !== '.git' && name !== 'node_modules' && (!name.startsWith('.') || name === '.github')
  })
  return markdownDocumentsFromRelativePaths(rootPath, relativePaths, limits)
}

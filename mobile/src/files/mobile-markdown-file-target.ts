import { fileUriToFilesystemPath } from '../../../src/shared/file-uri-path'
import { normalizeFilePath } from '../components/markdown-file-path-detection'
import { parseMobileFileTapTarget, type MobileFileTapTarget } from './mobile-file-tap-target'

function parseLineFragment(hash: string): Pick<MobileFileTapTarget, 'line' | 'column'> {
  let decoded = hash
  try {
    decoded = decodeURIComponent(hash)
  } catch {}
  const match = /^(?:L|line-?)([1-9]\d*)(?:C([1-9]\d*))?/i.exec(decoded)
  const line = match ? Number.parseInt(match[1]!, 10) : null
  const column = match?.[2] ? Number.parseInt(match[2], 10) : null
  return {
    line: line !== null && Number.isSafeInteger(line) ? line : null,
    column: column !== null && Number.isSafeInteger(column) ? column : null
  }
}

function decodeHrefPath(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function parsePathText(
  pathText: string,
  fragment: Pick<MobileFileTapTarget, 'line' | 'column'>
): MobileFileTapTarget | null {
  let decodedPath = decodeHrefPath(pathText)
  if (decodedPath.includes('/')) {
    decodedPath = decodedPath.replace(/\\([()])/g, '$1')
  }
  const parsed = parseMobileFileTapTarget(decodedPath)
  if (!parsed) {
    return null
  }
  return {
    pathText: normalizeFilePath(parsed.pathText),
    line: parsed.line ?? fragment.line,
    column: parsed.column ?? fragment.column
  }
}

function isMarkdownTitle(value: string): boolean {
  return /^(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|\((?:\\.|[^)])*\))$/.test(value)
}

export function normalizeMobileMarkdownDestination(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed.startsWith('<')) {
    const closeIndex = trimmed.indexOf('>')
    if (closeIndex < 0) {
      return null
    }
    const title = trimmed.slice(closeIndex + 1).trim()
    return !title || isMarkdownTitle(title) ? trimmed.slice(1, closeIndex) : null
  }
  const whitespaceIndex = trimmed.search(/\s/)
  if (whitespaceIndex < 0) {
    return trimmed
  }
  const title = trimmed.slice(whitespaceIndex).trim()
  return isMarkdownTitle(title) ? trimmed.slice(0, whitespaceIndex) : null
}

export function parseMobileMarkdownFileTarget(href: string): MobileFileTapTarget | null {
  const trimmed = normalizeMobileMarkdownDestination(href)
  if (!trimmed || trimmed.startsWith('#')) {
    return null
  }
  if (trimmed.toLowerCase().startsWith('file:')) {
    try {
      const url = new URL(trimmed)
      const pathText = fileUriToFilesystemPath(url)
      return pathText
        ? parsePathText(pathText, parseLineFragment(url.hash.replace(/^#/, '')))
        : null
    } catch {
      return null
    }
  }
  if (!/^[A-Za-z]:[\\/]/.test(trimmed) && /^[A-Za-z][A-Za-z0-9+.-]*:/.test(trimmed)) {
    return null
  }
  const hashIndex = trimmed.indexOf('#')
  const queryIndex = trimmed.indexOf('?')
  const suffixIndex =
    hashIndex < 0 ? queryIndex : queryIndex < 0 ? hashIndex : Math.min(hashIndex, queryIndex)
  const pathText = suffixIndex < 0 ? trimmed : trimmed.slice(0, suffixIndex)
  const hash =
    hashIndex < 0
      ? ''
      : trimmed.slice(hashIndex + 1, queryIndex > hashIndex ? queryIndex : undefined)
  return parsePathText(pathText, parseLineFragment(hash))
}

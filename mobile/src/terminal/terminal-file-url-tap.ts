import type { TappedFilePath } from './terminal-path-tap'
import { parsePathWithOptionalLineColumn } from './terminal-path-tap'

export function resolveTerminalFileUrlTap(uri: string): TappedFilePath | null {
  let parsed: URL
  try {
    parsed = new URL(uri)
  } catch {
    return null
  }
  const filePath = terminalFileUriToPathText(parsed)
  if (!filePath) {
    return null
  }
  const hashTarget = parseFileUrlLineHash(parsed.hash)
  if (hashTarget) {
    return { pathText: filePath, line: hashTarget.line, column: hashTarget.column }
  }
  if (/%3a/i.test(parsed.pathname)) {
    return { pathText: filePath, line: null, column: null }
  }
  return (
    parseFilePathTrailingLineTarget(filePath) ?? { pathText: filePath, line: null, column: null }
  )
}

export function resolveTerminalOscFileTap(uri: string): TappedFilePath | null {
  return resolveTerminalFileUrlTap(uri) ?? parseOscPathLikeTarget(uri)
}

function terminalFileUriToPathText(url: URL): string | null {
  if (url.protocol !== 'file:') {
    return null
  }
  let decodedPath: string
  try {
    decodedPath = decodeURIComponent(url.pathname)
  } catch {
    return null
  }
  if (url.hostname && !isLocalFileUriHostname(url.hostname)) {
    return `//${url.hostname}${decodedPath}`
  }
  if (/^\/[A-Za-z]:\//.test(decodedPath)) {
    return decodedPath.slice(1)
  }
  return decodedPath || null
}

function isLocalFileUriHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === '[::1]'
  )
}

function parseOscPathLikeTarget(value: string): TappedFilePath | null {
  if (
    !/^(?:~[\\/]|[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/]|[A-Za-z0-9._-]+[\\/]|(?=[A-Za-z0-9._-]*\.[A-Za-z0-9]))/.test(
      value
    )
  ) {
    return null
  }
  return parsePathWithOptionalLineColumn(value)
}

function parseFileUrlLineHash(hash: string): { line: number; column: number | null } | null {
  const match = /^#?L(\d+)(?:C(\d+))?$/i.exec(hash)
  if (!match) {
    return null
  }
  const line = Number.parseInt(match[1]!, 10)
  const column = match[2] ? Number.parseInt(match[2], 10) : null
  if (line < 1 || (column !== null && column < 1)) {
    return null
  }
  return { line, column }
}

function parseFilePathTrailingLineTarget(filePath: string): TappedFilePath | null {
  const match = /^(.*?)(?::(\d+))(?::(\d+))?$/.exec(filePath)
  if (!match || !match[1] || match[1].endsWith('/') || match[1].endsWith('\\')) {
    return null
  }
  const line = Number.parseInt(match[2]!, 10)
  const column = match[3] ? Number.parseInt(match[3], 10) : null
  if (line < 1 || (column !== null && column < 1)) {
    return null
  }
  return { pathText: match[1], line, column }
}

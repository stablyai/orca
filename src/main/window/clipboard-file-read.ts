import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export type ClipboardFileReadDeps = {
  platform: NodeJS.Platform
  desktop?: string
  readFormat: (format: string) => string
  readBuffer: (format: string) => Buffer
  runCommand: (command: string, args: string[], timeoutMs?: number) => Promise<string>
}

export const CLIPBOARD_FILE_LIST_MAX_BYTES = 64 * 1024
export const CLIPBOARD_FILE_LIST_MAX_PATHS = 256
export const CLIPBOARD_FILE_READ_TIMEOUT_MS = 2_000

export function runClipboardCommandCapture(
  command: string,
  args: string[],
  timeoutMs = CLIPBOARD_FILE_READ_TIMEOUT_MS
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] })
    const chunks: Buffer[] = []
    let received = 0
    let settled = false

    const finish = (error?: Error, value?: string): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      if (error) {
        if (!child.killed && child.exitCode === null) {
          child.kill('SIGKILL')
        }
        reject(error)
        return
      }
      resolve(value ?? '')
    }

    const timer = setTimeout(() => {
      finish(new Error(`${command} timed out`))
    }, timeoutMs)

    child.stdout?.on('data', (chunk: Buffer) => {
      received += chunk.length
      if (received > CLIPBOARD_FILE_LIST_MAX_BYTES) {
        finish(new Error(`${command} exceeded ${CLIPBOARD_FILE_LIST_MAX_BYTES} bytes`))
        return
      }
      chunks.push(chunk)
    })
    child.on('error', (error) => finish(error))
    // Why: close waits until stdout is drained; exit can race the final data event.
    child.on('close', (code) =>
      code === 0
        ? finish(undefined, Buffer.concat(chunks).toString('utf8'))
        : finish(new Error(`${command} exited with ${code}`))
    )
  })
}

export async function readClipboardFilePaths(deps: ClipboardFileReadDeps): Promise<string[]> {
  try {
    if (deps.platform === 'darwin') {
      return readMacClipboardFiles(deps)
    }
    if (deps.platform === 'win32') {
      return decodeFileNameWList(safeReadBuffer(deps, 'FileNameW'))
    }
    return await readLinuxClipboardFiles(deps)
  } catch {
    return []
  }
}

function readMacClipboardFiles(deps: ClipboardFileReadDeps): string[] {
  const legacyPaths = parseFilenamesPlist(readClipboardFormatText(deps, 'NSFilenamesPboardType'))
  return legacyPaths.length > 0
    ? legacyPaths
    : parseFileReferences(readClipboardText(deps, 'public.file-url'))
}

async function readLinuxClipboardFiles(deps: ClipboardFileReadDeps): Promise<string[]> {
  const deadline = Date.now() + CLIPBOARD_FILE_READ_TIMEOUT_MS
  const mimeTypes = /kde/i.test(deps.desktop ?? '')
    ? (['text/uri-list', 'x-special/gnome-copied-files'] as const)
    : (['x-special/gnome-copied-files', 'text/uri-list'] as const)

  for (const mime of mimeTypes) {
    const fromElectron = parseLinuxClipboardPayload(readClipboardText(deps, mime), mime)
    if (fromElectron.length > 0) {
      return fromElectron
    }
    for (const [command, args] of [
      ['wl-paste', ['--type', mime, '--no-newline']],
      ['xclip', ['-selection', 'clipboard', '-t', mime, '-o']]
    ] as const) {
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) {
        return []
      }
      try {
        const paths = parseLinuxClipboardPayload(
          await deps.runCommand(command, [...args], remainingMs),
          mime
        )
        if (paths.length > 0) {
          return paths
        }
      } catch {
        // Try the next clipboard tool or format.
      }
    }
  }
  return []
}

function parseLinuxClipboardPayload(payload: string, mime: string): string[] {
  const text = stripTrailingNulls(payload)
  if (!text.trim()) {
    return []
  }
  if (mime === 'x-special/gnome-copied-files') {
    return parseFileReferences(text.split(/\r?\n/u).slice(1).join('\n'))
  }
  return parseFileReferences(text)
}

function parseFilenamesPlist(plist: string): string[] {
  const paths: string[] = []
  const stringEntry = /<string>([\s\S]*?)<\/string>/gu
  let match: RegExpExecArray | null
  while (paths.length < CLIPBOARD_FILE_LIST_MAX_PATHS && (match = stringEntry.exec(plist))) {
    const filePath = usableClipboardPath(unescapeXml(match[1]).trim())
    if (filePath && !paths.includes(filePath)) {
      paths.push(filePath)
    }
  }
  return paths
}

function parseFileReferences(payload: string): string[] {
  const paths: string[] = []
  for (const rawLine of payload.split(/\r?\n/u)) {
    if (paths.length >= CLIPBOARD_FILE_LIST_MAX_PATHS) {
      break
    }
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) {
      continue
    }
    const filePath = decodeClipboardFileReference(line)
    if (filePath && !paths.includes(filePath)) {
      paths.push(filePath)
    }
  }
  return paths
}

function decodeClipboardFileReference(value: string): string | null {
  if (value.startsWith('file:')) {
    try {
      return usableClipboardPath(fileURLToPath(value))
    } catch {
      return null
    }
  }
  return usableClipboardPath(value)
}

function decodeFileNameWList(value: Buffer): string[] {
  if (value.byteLength < 2 || value.byteLength % 2 !== 0) {
    return []
  }
  const paths: string[] = []
  let offset = 0
  while (offset + 2 <= value.byteLength && paths.length < CLIPBOARD_FILE_LIST_MAX_PATHS) {
    let end = offset
    while (end + 2 <= value.byteLength && value.readUInt16LE(end) !== 0) {
      end += 2
    }
    if (end === offset) {
      break
    }
    const filePath = usableClipboardPath(value.subarray(offset, end).toString('utf16le'))
    if (filePath && !paths.includes(filePath)) {
      paths.push(filePath)
    }
    offset = end + 2
  }
  return paths
}

function usableClipboardPath(filePath: string): string | null {
  if (!filePath || filePath.includes('\0') || filePath.startsWith('/.file/')) {
    return null
  }
  if (filePath.startsWith('/') || isFullyQualifiedWindowsPath(filePath)) {
    return filePath
  }
  return null
}

function isFullyQualifiedWindowsPath(filePath: string): boolean {
  if (/^[A-Za-z]:[\\/]/u.test(filePath) || /^\\\\\?\\[A-Za-z]:\\/u.test(filePath)) {
    return true
  }
  const extendedUnc = /^\\\\\?\\UNC\\[^\\/]+\\([^\\/]+)(?:\\|$)/iu.exec(filePath)
  if (extendedUnc) {
    return isOrdinaryUncShare(extendedUnc[1])
  }
  const unc = /^[/\\]{2}(?![?.][/\\])[^/\\]+[/\\]([^/\\]+)(?:[/\\]|$)/u.exec(filePath)
  return isOrdinaryUncShare(unc?.[1])
}

function isOrdinaryUncShare(share: string | undefined): boolean {
  return typeof share === 'string' && share.toLowerCase() !== 'pipe'
}

function readClipboardText(deps: ClipboardFileReadDeps, format: string): string {
  return stripTrailingNulls(safeReadBuffer(deps, format).toString('utf8'))
}

function readClipboardFormatText(deps: ClipboardFileReadDeps, format: string): string {
  try {
    const value = deps.readFormat(format)
    if (
      typeof value === 'string' &&
      value.length > 0 &&
      Buffer.byteLength(value, 'utf8') <= CLIPBOARD_FILE_LIST_MAX_BYTES
    ) {
      return stripTrailingNulls(value)
    }
  } catch {
    // Fall back to the raw buffer form.
  }
  return readClipboardText(deps, format)
}

function safeReadBuffer(deps: ClipboardFileReadDeps, format: string): Buffer {
  try {
    const value = deps.readBuffer(format)
    if (!Buffer.isBuffer(value) || value.byteLength > CLIPBOARD_FILE_LIST_MAX_BYTES) {
      return Buffer.alloc(0)
    }
    return value
  } catch {
    return Buffer.alloc(0)
  }
}

function stripTrailingNulls(value: string): string {
  return value.replace(/\0+$/u, '')
}

function unescapeXml(value: string): string {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')
}

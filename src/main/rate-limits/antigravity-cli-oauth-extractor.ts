import { execFile } from 'node:child_process'
import { access, open, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const CLIENT_ID_RE = /[0-9]{10,}-[a-z0-9]+\.apps\.googleusercontent\.com/g
const SECRET_PREFIX = 'GOCSPX-'
const SECRET_BODY_RE = /[A-Za-z0-9_-]/
const MIN_SECRET_BODY = 12
const MAX_SECRET_BODY = 28
const CHUNK_SIZE = 1024 * 1024
const OVERLAP = 200
const MAX_REFRESH_CLIENTS = 12

export type AntigravityOAuthClient = {
  clientId: string
  clientSecret: string
}

let cachedClients: AntigravityOAuthClient[] | null = null
let cachedBinaryPath: string | null = null

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

async function resolveAgyBinary(): Promise<string | null> {
  const [lookup, args] = process.platform === 'win32' ? ['where.exe', ['agy']] : ['which', ['agy']]
  try {
    const { stdout } = await execFileAsync(lookup, args, {
      encoding: 'utf-8',
      windowsHide: true
    })
    const fromPath = stdout.trim().split(/\r?\n/)[0]
    if (fromPath && (await fileExists(fromPath))) {
      return fromPath
    }
  } catch {
    // ignore which/where failure
  }

  const home = homedir()
  const fallbacks =
    process.platform === 'win32'
      ? [
          process.env.LOCALAPPDATA
            ? path.join(process.env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe')
            : null
        ]
      : [
          path.join(home, '.local', 'bin', 'agy'),
          '/opt/homebrew/bin/agy',
          '/usr/local/bin/agy',
          path.join(home, 'bin', 'agy')
        ]

  for (const candidate of fallbacks) {
    if (candidate && (await fileExists(candidate))) {
      return candidate
    }
  }
  return null
}

function collectMatches(haystack: string, pattern: RegExp, into: string[]): void {
  pattern.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(haystack))) {
    const value = match[0]
    if (!into.includes(value)) {
      into.push(value)
    }
  }
}

function readSecretAt(haystack: string, start: number): string | null {
  if (!haystack.startsWith(SECRET_PREFIX, start)) {
    return null
  }
  let end = start + SECRET_PREFIX.length
  const maxEnd = end + MAX_SECRET_BODY
  while (end < haystack.length && end < maxEnd && SECRET_BODY_RE.test(haystack[end]!)) {
    if (
      haystack.startsWith('https://', end) ||
      haystack.startsWith('http://', end) ||
      haystack.startsWith(SECRET_PREFIX, end)
    ) {
      break
    }
    end += 1
  }
  const secret = haystack.slice(start, end)
  return secret.length - SECRET_PREFIX.length >= MIN_SECRET_BODY ? secret : null
}

function collectSecrets(haystack: string, into: string[]): void {
  let searchFrom = 0
  while (searchFrom < haystack.length) {
    const start = haystack.indexOf(SECRET_PREFIX, searchFrom)
    if (start === -1) {
      return
    }
    const secret = readSecretAt(haystack, start)
    if (secret && !into.includes(secret)) {
      into.push(secret)
    }
    searchFrom = start + SECRET_PREFIX.length
  }
}

function cartesianClients(clientIds: string[], clientSecrets: string[]): AntigravityOAuthClient[] {
  const paired: AntigravityOAuthClient[] = []
  for (const clientId of clientIds) {
    for (const clientSecret of clientSecrets) {
      paired.push({ clientId, clientSecret })
      if (paired.length >= MAX_REFRESH_CLIENTS) {
        return paired
      }
    }
  }
  return paired
}

export async function scanAgyBinaryForOAuthClients(
  binaryPath: string
): Promise<AntigravityOAuthClient[]> {
  const handle = await open(binaryPath, 'r')
  try {
    const fileStat = await stat(binaryPath)
    const buffer = Buffer.alloc(CHUNK_SIZE)
    const clientIds: string[] = []
    const clientSecrets: string[] = []
    let previous = ''
    let position = 0
    while (position < fileStat.size) {
      const { bytesRead } = await handle.read(buffer, 0, CHUNK_SIZE, position)
      if (bytesRead === 0) {
        break
      }
      const text = previous + buffer.toString('latin1', 0, bytesRead)
      collectMatches(text, CLIENT_ID_RE, clientIds)
      collectSecrets(text, clientSecrets)
      previous = text.slice(-OVERLAP)
      position += bytesRead
    }

    return cartesianClients(clientIds, clientSecrets)
  } finally {
    await handle.close()
  }
}

export async function extractAntigravityOAuthClients(): Promise<AntigravityOAuthClient[]> {
  const binaryPath = await resolveAgyBinary()
  if (!binaryPath) {
    return []
  }
  if (cachedClients && cachedBinaryPath === binaryPath) {
    return cachedClients
  }
  const clients = await scanAgyBinaryForOAuthClients(binaryPath)
  cachedBinaryPath = binaryPath
  cachedClients = clients
  return clients
}

export function resetAntigravityOAuthClientCache(): void {
  cachedClients = null
  cachedBinaryPath = null
}

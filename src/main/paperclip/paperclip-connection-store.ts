import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { PaperclipConnectionIdentity } from '../../shared/paperclip-types'
import { createPaperclipConnectionId } from './paperclip-connection-id'
import { parsePaperclipOrigin } from './paperclip-origin-policy'

let cachedConnection: PaperclipConnectionIdentity | null | undefined
const filePath = (): string => join(homedir(), '.orca', 'paperclip-connection.json')

export function getPaperclipConnection(): PaperclipConnectionIdentity | null {
  if (cachedConnection !== undefined) {
    return cachedConnection
  }
  try {
    cachedConnection = normalizePaperclipConnection(JSON.parse(readFileSync(filePath(), 'utf8')))
  } catch {
    cachedConnection = null
  }
  return cachedConnection
}

export function savePaperclipConnection(connection: PaperclipConnectionIdentity): void {
  mkdirSync(join(homedir(), '.orca'), { recursive: true })
  cachedConnection = normalizePaperclipConnection(connection)
  if (!cachedConnection) {
    throw new Error('Cannot persist an invalid Paperclip connection.')
  }
  writeFileSync(filePath(), JSON.stringify(cachedConnection, null, 2), {
    encoding: 'utf8',
    mode: 0o600
  })
}

export function clearPaperclipConnection(): void {
  cachedConnection = null
  if (existsSync(filePath())) {
    unlinkSync(filePath())
  }
}

export function normalizePaperclipConnection(value: unknown): PaperclipConnectionIdentity | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const item = value as Record<string, unknown>
  if (
    !['id', 'origin', 'companyId', 'projectId'].every(
      (key) => typeof item[key] === 'string' && (item[key] as string).trim().length > 0
    )
  ) {
    return null
  }
  try {
    const origin = parsePaperclipOrigin(item.origin as string).origin
    const id = createPaperclipConnectionId(
      origin,
      item.companyId as string,
      item.projectId as string
    )
    if (item.id !== id) {
      return null
    }
    return {
      id,
      origin,
      companyId: item.companyId as string,
      projectId: item.projectId as string
    }
  } catch {
    return null
  }
}

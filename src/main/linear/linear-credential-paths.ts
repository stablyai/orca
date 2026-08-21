import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const LEGACY_WORKSPACE_ID = 'legacy'

function getMCodeDir(): string {
  return join(homedir(), '.mcode')
}

function getLegacyTokenPath(): string {
  return join(getMCodeDir(), 'linear-token.enc')
}

export function getLegacyViewerPath(): string {
  return join(getMCodeDir(), 'linear-viewer.json')
}

export function getWorkspaceFilePath(): string {
  return join(getMCodeDir(), 'linear-workspaces.json')
}

function getWorkspaceTokenDir(): string {
  return join(getMCodeDir(), 'linear-tokens')
}

export function getWorkspaceTokenPath(workspaceId: string): string {
  if (workspaceId === LEGACY_WORKSPACE_ID) {
    return getLegacyTokenPath()
  }
  return join(getWorkspaceTokenDir(), `${Buffer.from(workspaceId).toString('base64url')}.enc`)
}

export function ensureMCodeDir(): void {
  const dir = getMCodeDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

export function ensureWorkspaceTokenDir(): void {
  const dir = getWorkspaceTokenDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

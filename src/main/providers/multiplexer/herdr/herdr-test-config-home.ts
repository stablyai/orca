import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SOCKET_PATH_LIMIT = 104

export function configHomeDir(): string {
  for (const root of [tmpdir(), '/tmp']) {
    const candidate = mkdtempSync(join(root, 'orca-h-'))
    if (socketPathLength(candidate) <= SOCKET_PATH_LIMIT) {
      return candidate
    }
    rmSync(candidate, { recursive: true, force: true })
  }
  throw new Error('No writable temp dir yields a short enough herdr socket path')
}

function socketPathLength(configHome: string): number {
  return configHome.length + '/.config/herdr/sessions/ot-123456/herdr.sock'.length
}

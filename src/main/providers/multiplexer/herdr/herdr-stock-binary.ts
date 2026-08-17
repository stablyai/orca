import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Resolve a stock herdr binary for live tests: explicit env, then PATH. */
export function resolveStockHerdrTestBinary(): string | null {
  const explicit = process.env.ORCA_HERDR_TEST_BINARY?.trim()
  if (explicit && existsSync(explicit)) {
    return explicit
  }
  try {
    const found = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['herdr'], {
      encoding: 'utf8'
    })
      .trim()
      .split(/\r?\n/)[0]
    return found && existsSync(found) ? found : null
  } catch {
    return null
  }
}

const SOCKET_PATH_LIMIT = 104

export function configHomeDir(): string {
  for (const root of [tmpdir(), '/tmp']) {
    const candidate = mkdtempSync(join(root, 'orca-h-'))
    if (
      candidate.length + '/.config/herdr/sessions/ot-123456/herdr.sock'.length <=
      SOCKET_PATH_LIMIT
    ) {
      return candidate
    }
    rmSync(candidate, { recursive: true, force: true })
  }
  throw new Error('No writable temp dir yields a short enough herdr socket path')
}

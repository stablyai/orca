import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Ratchet for stablyai/orca#16441.
 *
 * Codex hook trust used to be granted by blocking the Electron main thread on
 * `spawnSync` of a bundled ELECTRON_RUN_AS_NODE entry, for the whole
 * app-server deadline: 15s native, 35s WSL, ~45s on the three-session real-home
 * path. The window showed "Not Responding" during cold start and pane launch.
 *
 * The subprocess only ever existed to donate an event loop to a deliberately
 * blocked parent, so this guards the shape of the fix rather than one call
 * site: nothing on the trust-grant lane may start a child process
 * synchronously, and the forked entry must stay gone.
 */
const CODEX_DIR = __dirname

const SYNC_SPAWN_PATTERN = /\b(?:spawnSync|execSync|execFileSync|runProcessSync)\s*[(<]/

/** Drop comments so the prose explaining the old idiom is not an offender. */
function codeText(contents: string): string {
  return contents
    .split('\n')
    .filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line))
    .join('\n')
}

function listCodexSourceFiles(): string[] {
  return readdirSync(CODEX_DIR).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
}

describe('codex trust grant main-thread boundary', () => {
  it('starts no child process synchronously anywhere in the codex module', () => {
    const offenders = listCodexSourceFiles().filter((name) =>
      SYNC_SPAWN_PATTERN.test(codeText(readFileSync(join(CODEX_DIR, name), 'utf8')))
    )
    expect(offenders).toEqual([])
  })

  it('keeps the forked grant entry and its blocking bridge deleted', () => {
    for (const name of [
      'codex-app-server-grant-bridge.ts',
      'codex-app-server-grant-entry.ts',
      'codex-app-server-grant-envelope.ts'
    ]) {
      expect(existsSync(join(CODEX_DIR, name))).toBe(false)
    }
  })

  it('keeps the trust-grant lane on async entry points', () => {
    const grant = readFileSync(join(CODEX_DIR, 'codex-hook-trust-grant.ts'), 'utf8')
    expect(grant).toContain('export async function grantManagedCodexHookTrust(')
    const host = readFileSync(join(CODEX_DIR, 'codex-trust-grant-host.ts'), 'utf8')
    expect(host).toContain('export async function resolveCodexTrustGrantHost(')
    const realHome = readFileSync(join(CODEX_DIR, 'codex-real-home-hook-install.ts'), 'utf8')
    expect(realHome).toContain('}): Promise<RealHomeCodexHookLane> {')
  })
})

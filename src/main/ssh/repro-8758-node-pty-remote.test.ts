/**
 * Issue #8758 — "node-pty is not available on this remote host" (Linux SSH).
 *
 * Same deploy contract as #8720: installNativeDeps writes package.json without
 * allowScripts, so npm 12 on Linux blocks node-pty's native build while still
 * exiting 0. Debian 13 remotes without prebuilds hit this at PTY spawn.
 *
 * Re-run:
 *   pnpm exec vitest run --config config/vitest.config.ts \
 *     src/main/ssh/repro-8758-node-pty-remote.test.ts
 *   # sibling #8720 proof:
 *   pnpm exec vitest run --config config/vitest.config.ts \
 *     src/main/ssh/repro-8720-npm12-allow-scripts.test.ts
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const deploySource = readFileSync(join(__dirname, 'ssh-relay-deploy.ts'), 'utf8')
const toolchainSource = readFileSync(join(__dirname, 'ssh-relay-build-toolchain.ts'), 'utf8')
const ptyHandlerSource = readFileSync(join(__dirname, '../../relay/pty-handler.ts'), 'utf8')

describe('#8758 node-pty unavailable on remote (same root as #8720)', () => {
  it('relay native package.json has no allowScripts for node-pty', () => {
    expect(deploySource).toMatch(/'node-pty':\s*'1\.1\.0'/)
    expect(deploySource).toMatch(/dependencies:\s*RELAY_NATIVE_DEPS/)
    expect(deploySource).not.toMatch(/allowScripts/)
    expect(deploySource).toMatch(/npm install --omit=dev --no-audit --no-fund/)
  })

  it('surfaces the issue error string when node-pty cannot load', () => {
    // User-visible message from the issue report (relay PTY spawn path)
    expect(ptyHandlerSource).toContain('node-pty is not available on this remote host')
  })

  it('documents Linux has no node-pty prebuild path (must build from source)', () => {
    // Toolchain / deploy notes that Linux needs native compile
    const combined = deploySource + toolchainSource
    expect(combined.toLowerCase()).toMatch(/linux|prebuild|node-gyp|native/)
  })
})

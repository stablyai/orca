/**
 * Issue #8720 — SSH relay npm install silently skips node-pty under npm 12 (allowScripts).
 *
 * npm 12 blocks lifecycle scripts not listed in package.json `allowScripts` (or
 * approved via allow-scripts). The generated relay package.json only pins
 * dependencies — no allowScripts — so node-pty's install/postinstall never run on
 * Linux (no prebuild), while npm still exits 0 → .install-complete is written.
 *
 * Re-run:
 *   pnpm exec vitest run --config config/vitest.config.ts \
 *     src/main/ssh/repro-8720-npm12-allow-scripts.test.ts
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Mirrors ssh-relay-deploy.ts RELAY_NATIVE_DEPS + pkgJson construction. */
function buildRelayPackageJson(): Record<string, unknown> {
  const RELAY_NATIVE_DEPS = {
    'node-pty': '1.1.0',
    '@parcel/watcher': '2.5.6'
  } as const
  return {
    name: 'orca-relay',
    version: '1.0.0',
    private: true,
    type: 'commonjs',
    dependencies: RELAY_NATIVE_DEPS
  }
}

describe('issue #8720 relay package.json lacks allowScripts for npm 12', () => {
  it('source-written package.json has deps but no allowScripts field', () => {
    const deploySource = readFileSync(join(__dirname, 'ssh-relay-deploy.ts'), 'utf8')

    // Pinned native deps that need lifecycle scripts on Linux
    expect(deploySource).toMatch(/'node-pty':\s*'1\.1\.0'/)
    expect(deploySource).toMatch(/'@parcel\/watcher':\s*'2\.5\.6'/)

    // Generated package.json shape in installNativeDeps
    expect(deploySource).toMatch(/name:\s*'orca-relay'/)
    expect(deploySource).toMatch(/dependencies:\s*RELAY_NATIVE_DEPS/)

    // Bug: no allowScripts (npm 12 sanctioned mechanism) on the written package.json
    expect(deploySource).not.toMatch(/allowScripts/)
    expect(deploySource).not.toMatch(/allow-scripts/)
  })

  it('npm install command does not approve lifecycle scripts', () => {
    const deploySource = readFileSync(join(__dirname, 'ssh-relay-deploy.ts'), 'utf8')
    expect(deploySource).toMatch(/npm install --omit=dev --no-audit --no-fund/)
    expect(deploySource).not.toMatch(/npm install-scripts/)
    expect(deploySource).not.toMatch(/--ignore-scripts=false/)
  })

  it('synthetic package.json matches deploy contract and is incomplete for npm 12', () => {
    const pkgJson = buildRelayPackageJson()
    expect(pkgJson.dependencies).toEqual({
      'node-pty': '1.1.0',
      '@parcel/watcher': '2.5.6'
    })
    expect(pkgJson).not.toHaveProperty('allowScripts')
    // npm 12: without allowScripts covering node-pty install, scripts are blocked
    // while exit code stays 0 (strict-allow-scripts default false).
    expect('allowScripts' in pkgJson).toBe(false)
  })

  it('existing native-deps install test pins deps without asserting allowScripts', () => {
    const harness = readFileSync(join(__dirname, 'ssh-relay-native-deps-install.test.ts'), 'utf8')
    expect(harness).toContain("'@parcel/watcher': '2.5.6'")
    expect(harness).toContain("'node-pty': '1.1.0'")
    expect(harness).not.toMatch(/allowScripts/)
  })
})

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { assertMacGuiLaunchAllowed } from './macos-gui-launch-preflight.mjs'

describe('macOS GUI launch preflight', () => {
  it.skipIf(process.platform !== 'darwin').each([undefined, '/must-not-launch/chromium'])(
    'fixture server refuses primary and fallback browser launches with override %s',
    (override) => {
      const stubs = {
        'playwright-core': `export const chromium = { launch() {
          console.error('must-not-launch-browser')
          throw new Error('must-not-launch-browser')
        } }`,
        vite: `export function createServer() {
          throw new Error('must-not-start-vite')
        }`,
        'node:net': `export function createServer() { return {
          once() {},
          listen(port, host, ready) { ready() },
          address() { return { port: 1234 } },
          close(done) { done() }
        } }`
      }
      const preload = `import { registerHooks } from 'node:module'
        const stubs = ${JSON.stringify(stubs)}
        registerHooks({ resolve(specifier, context, nextResolve) {
          return Object.hasOwn(stubs, specifier)
            ? { url: 'data:text/javascript,' + encodeURIComponent(stubs[specifier]), shortCircuit: true }
            : nextResolve(specifier, context)
        } })`
      const result = spawnSync(
        process.execPath,
        [
          '--import',
          `data:text/javascript,${encodeURIComponent(preload)}`,
          fileURLToPath(new URL('./component-fixtures/fixture-server.mjs', import.meta.url))
        ],
        {
          encoding: 'utf8',
          timeout: 10000,
          env: {
            ...process.env,
            CODEX_SANDBOX: 'seatbelt',
            ORCA_BACKGROUND_LAUNCH: '1',
            ORCA_FIXTURES_BROWSER: override ?? ''
          }
        }
      )
      expect(result.signal).toBeNull()
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('outside the Codex sandbox')
      expect(result.stderr).toContain('headless browsers')
      expect(result.stderr).not.toContain('must-not-launch-browser')
      expect(result.stderr).not.toContain('must-not-start-vite')
      expect(result.stderr).not.toContain('No headless Chromium found')
    }
  )

  it.skipIf(process.platform !== 'darwin')(
    'dev runner exits before preparing or starting Electron',
    () => {
      const result = spawnSync(
        process.execPath,
        [fileURLToPath(new URL('./run-electron-vite-dev.mjs', import.meta.url))],
        {
          encoding: 'utf8',
          timeout: 10000,
          env: {
            ...process.env,
            CODEX_SANDBOX: 'seatbelt',
            ORCA_BACKGROUND_LAUNCH: '1',
            ORCA_ELECTRON_VITE_CLI: 'must-not-launch.mjs'
          }
        }
      )
      expect(result.signal).toBeNull()
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('outside the Codex sandbox')
      expect(result.stderr).not.toContain('must-not-launch')
      expect(result.stdout).not.toContain('Prepared wrapper')
    }
  )

  it('refuses a hidden Electron launch in the Codex seatbelt before native startup', () => {
    expect(() =>
      assertMacGuiLaunchAllowed({
        platform: 'darwin',
        env: {
          CODEX_SANDBOX: 'seatbelt',
          ORCA_BACKGROUND_LAUNCH: '1',
          ORCA_E2E_HEADLESS: '1'
        }
      })
    ).toThrow(/outside the Codex sandbox/)
  })

  it('permits an approved macOS launch outside seatbelt', () => {
    expect(() =>
      assertMacGuiLaunchAllowed({
        platform: 'darwin',
        env: {
          ORCA_BACKGROUND_LAUNCH: '1'
        }
      })
    ).not.toThrow()
  })

  it.each(['linux', 'win32'])('does not apply macOS launch restrictions on %s', (platform) => {
    expect(() =>
      assertMacGuiLaunchAllowed({
        platform,
        env: {
          CODEX_SANDBOX: 'seatbelt'
        }
      })
    ).not.toThrow()
  })
})

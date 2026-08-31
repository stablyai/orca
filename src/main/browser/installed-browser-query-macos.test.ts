import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { queryHttpsHandlersMacOS } from './installed-browser-query-macos'
import {
  filterChromiumCandidates,
  firstChromiumProfileWithCookies
} from './installed-browser-discovery'
import { customBrowsersFromCandidates } from './custom-browser-detection'

describe('queryHttpsHandlersMacOS (parsing)', () => {
  it('parses valid osascript JSON into candidates', async () => {
    const run = (): Promise<string> =>
      Promise.resolve(
        JSON.stringify([
          {
            bundleId: 'at.studio.AsideBrowser',
            displayName: 'Aside',
            appPath: '/Applications/Aside.app'
          },
          {
            bundleId: 'com.google.Chrome',
            displayName: 'Google Chrome',
            appPath: '/Applications/Google Chrome.app'
          }
        ])
      )
    const out = await queryHttpsHandlersMacOS(run)
    expect(out).toHaveLength(2)
    expect(out[0].bundleId).toBe('at.studio.AsideBrowser')
    expect(out[1].displayName).toBe('Google Chrome')
  })

  it('drops malformed entries', async () => {
    const run = (): Promise<string> =>
      Promise.resolve(
        JSON.stringify([{ bundleId: 'x' }, { bundleId: 'y', displayName: 'Y', appPath: '/Y.app' }])
      )
    expect(await queryHttpsHandlersMacOS(run)).toHaveLength(1)
  })

  it('returns [] when osascript output is not JSON', async () => {
    expect(await queryHttpsHandlersMacOS(() => Promise.resolve('not json'))).toEqual([])
  })
})

// Live proof on a real macOS machine. Skipped elsewhere (osascript is macOS-only).
// Run it yourself:
//   pnpm exec vitest run --config config/vitest.config.ts src/main/browser/installed-browser-query-macos.test.ts
describe('Part B live auto-discovery (macOS only)', () => {
  it.skipIf(process.platform !== 'darwin')(
    'lists installed browsers and resolves customs',
    async () => {
      const appSupportRoot = join(homedir(), 'Library', 'Application Support')
      const handlers = await queryHttpsHandlersMacOS()
      const chromium = filterChromiumCandidates(handlers, { appSupportRoot })
      const customs = customBrowsersFromCandidates(chromium, {
        knownBrowsers: [],
        appSupportRoot,
        existsSync,
        profilesFor: (dataDir) => firstChromiumProfileWithCookies(dataDir, { existsSync })
      })
      // process.stdout.write bypasses vitest's console capture so the proof is always visible.
      process.stdout.write(
        `\n[Part B] OS https-handlers: ${handlers.map((h) => h.displayName).join(', ')}\n`
      )
      process.stdout.write(
        `[Part B] auto-discovered custom browsers:\n  ${
          customs.map((c) => `${c.label} → ${c.cookiesPath}`).join('\n  ') || '(none)'
        }\n`
      )
      expect(Array.isArray(handlers)).toBe(true)
      expect(Array.isArray(customs)).toBe(true)
    }
  )
})

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mobileWebAppDependenciesPresent } from '../mobile-web-app-bundle-dependencies.mjs'
import {
  escapeDenseStream,
  FIRST_MARKER,
  LAST_MARKER,
  MIN_STREAM_BYTES
} from '../preview/mobile-web-app-terminal-probe-route.mjs'
import {
  openProbeTerminal,
  startTerminalRenderFixture
} from './mobile-web-app-terminal-render-fixture.mjs'

// Render real terminal modules/xterm under script-src self without unsafe-inline/eval; module tests cannot prove paint or CSP.
// Escape-dense TUI bytes stress transport; read exact transcript through real selection/Copy/onSelectionCopy path.
// Scratch route mounts terminal without scripting session’s full host handshake.

const bundles = mobileWebAppDependenciesPresent()
const describeRender = bundles ? describe : describe.skip

let fixture = null
const stream = escapeDenseStream()
const openTerminal = (options) => fixture.openTerminal(options)

beforeAll(async () => {
  if (!bundles) {
    return
  }
  fixture = await startTerminalRenderFixture()
}, 600_000)

afterAll(async () => {
  await fixture?.close()
})

async function terminalCspViolations(page) {
  return page.evaluate(() => globalThis.__orcaCspViolations)
}

describeRender(
  'the terminal on the page',
  () => {
    it('opens xterm under the shipped policy and paints a dense stream into its buffer', async () => {
      const fonts = []
      const { errors, page } = await openTerminal({
        beforeNavigate: async (page) => {
          page.on('response', (response) => {
            if (response.url().endsWith('.woff2')) {
              fonts.push(response)
            }
          })
        }
      })
      await openProbeTerminal(page)
      expect(fonts).toHaveLength(1)
      expect(fonts[0].status()).toBe(200)
      expect(fonts[0].headers()['content-type']).toBe('font/woff2')
      const fontUrl = new URL(fonts[0].url())
      expect(fontUrl.origin).toBe(new URL(page.url()).origin)
      expect(fontUrl.pathname).toMatch(/^\/assets\/[^/]+\.woff2$/)
      expect(
        await page.evaluate(() => document.fonts.check('13px "Orca Nerd Font Symbols"', '\ue0b0'))
      ).toBe(true)
      // Android has no system glyph for Claude Code's \u23f5\u23f5; a face still loading here would paint boxes.
      expect(
        await page.evaluate(
          () =>
            [...document.fonts].find(
              (face) => face.family.replaceAll('"', '') === 'Orca Terminal Symbols'
            )?.status
        )
      ).toBe('loaded')
      const applied = await page.evaluate((data) => {
        globalThis.__orcaTerminalProbe.write(data)
        return data.length
      }, stream)
      expect(applied).toBeGreaterThanOrEqual(MIN_STREAM_BYTES)

      // Read through real select-all/Copy overlay into onSelectionCopy, not private xterm state.
      await page.evaluate(() => globalThis.__orcaTerminalProbe.selectAll())
      await page.waitForFunction(
        () => document.getElementById('selection-overlay')?.classList.contains('active') === true,
        { timeout: 30_000, polling: 100 }
      )
      await page.evaluate(() => document.getElementById('sel-menu-copy').click())
      await page.waitForFunction(() => typeof globalThis.__orcaTerminalCopied === 'string', {
        timeout: 30_000,
        polling: 100
      })
      const copied = await page.evaluate(() => globalThis.__orcaTerminalCopied)
      console.log(
        '[c7.5][stream]',
        JSON.stringify({ appliedBytes: applied, readBackChars: copied.length })
      )
      expect(copied).toContain(FIRST_MARKER)
      expect(copied).toContain(LAST_MARKER)
      // Escape bytes must affect terminal, not print literally.
      expect(copied).not.toContain('\u001b')
      expect(copied).not.toContain('[31;1m')

      expect(await terminalCspViolations(page)).toEqual([])
      expect(await page.evaluate(() => globalThis.__orcaTerminalEngineErrors)).toEqual([])
      expect(errors).toEqual([])
      await page.close()
    }, 300_000)

    it('leaves the page its own window.onerror across mount and dispose', async () => {
      // Preserve preexisting page error-handler identity through mount/dispose; non-null/same-shape checks would miss replacement.
      const { page } = await openTerminal({ errorSentinel: true })
      expect(await page.evaluate(() => window.onerror === globalThis.__orcaSentinel)).toBe(true)
      await openProbeTerminal(page)
      expect(await page.evaluate(() => window.onerror === globalThis.__orcaSentinel)).toBe(true)

      // Require both page and terminal error reporters work; preserved page handler alone could hide broken terminal reporting.
      await page.evaluate(() => {
        setTimeout(() => {
          throw new Error('orca-terminal-render-uncaught')
        }, 0)
      })
      const sawIt = (entries) =>
        entries.some((entry) => entry.includes('orca-terminal-render-uncaught'))
      await page.waitForFunction(
        () =>
          globalThis.__orcaTerminalEngineErrors.some((entry) =>
            entry.includes('orca-terminal-render-uncaught')
          ),
        { timeout: 30_000, polling: 100 }
      )
      expect(sawIt(await page.evaluate(() => globalThis.__orcaSentinelCalls))).toBe(true)

      // Dispose removes terminal listener while retaining page handler.
      await page.evaluate(() => globalThis.__orcaTerminalProbe.setMounted(false))
      await page.locator('#terminal-container').waitFor({ state: 'detached', timeout: 30_000 })
      expect(await page.evaluate(() => window.onerror === globalThis.__orcaSentinel)).toBe(true)
      const before = await page.evaluate(() => {
        setTimeout(() => {
          throw new Error('orca-terminal-render-after-dispose')
        }, 0)
        return globalThis.__orcaTerminalEngineErrors.length
      })
      await page.waitForFunction(
        () =>
          globalThis.__orcaSentinelCalls.some((entry) =>
            entry.includes('orca-terminal-render-after-dispose')
          ),
        { timeout: 30_000, polling: 100 }
      )
      // Page must receive error after terminal reporter is disposed.
      expect(await page.evaluate(() => globalThis.__orcaTerminalEngineErrors.length)).toBe(before)
      await page.close()
    }, 300_000)

    async function assertLiveTerminal(page, label) {
      await page.locator('#terminal-surface .xterm').waitFor({ state: 'attached', timeout: 30_000 })
      expect(
        await page.evaluate(() => document.querySelectorAll('#terminal-surface .xterm').length),
        `${label}: xterm elements in the live DOM`
      ).toBeGreaterThan(0)

      // Overlay through handle proves message path targets current mounted elements.
      await page.evaluate(() => globalThis.__orcaTerminalProbe.selectAll())
      await page.waitForFunction(
        () => document.getElementById('selection-overlay')?.classList.contains('active') === true,
        { timeout: 30_000, polling: 100 }
      )

      // Error reporter must reinstall per mount.
      const marker = `orca-remount-${label}`
      await page.evaluate((thrown) => {
        globalThis.__orcaTerminalEngineErrors = []
        setTimeout(() => {
          throw new Error(thrown)
        }, 0)
      }, marker)
      await page.waitForFunction(
        (thrown) => globalThis.__orcaTerminalEngineErrors.some((entry) => entry.includes(thrown)),
        marker,
        { timeout: 30_000, polling: 100 }
      )
    }

    it('is a live terminal again after the user reloads a failed one', async () => {
      // Drive pre-init uncaught error through real fatal overlay/Reload; this user remount path must rebuild document inside same component.
      const { page } = await openTerminal()
      await page.locator('#terminal-container').waitFor({ state: 'attached', timeout: 30_000 })
      await page.evaluate(() => {
        setTimeout(() => {
          throw new Error('orca-terminal-render-fatal')
        }, 0)
      })
      const reload = page.getByText('Reload')
      await reload.waitFor({ timeout: 30_000 })

      await page.evaluate(() => {
        globalThis.__orcaTerminalReady = false
      })
      await reload.click()
      await page.waitForFunction(() => globalThis.__orcaTerminalReady === true, {
        timeout: 60_000,
        polling: 100
      })
      await openProbeTerminal(page)
      await assertLiveTerminal(page, 'after-reload')
      await page.close()
    }, 300_000)
  },
  900_000
)

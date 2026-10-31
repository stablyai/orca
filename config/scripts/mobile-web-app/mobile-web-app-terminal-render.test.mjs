import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import {
  escapeDenseStream,
  FIRST_MARKER,
  LAST_MARKER,
  MIN_STREAM_BYTES
} from './preview/mobile-web-app-terminal-probe-route.mjs'
import {
  CONTROL_ROUTE,
  openProbeTerminal,
  PROBE_ROUTE,
  startTerminalRenderFixture
} from './mobile-web-app-terminal-render-fixture.mjs'
import {
  readRootComputedStyles,
  terminalStyleReach
} from './preview/mobile-web-app-render-harness.mjs'

// Render real terminal modules/xterm under script-src self without unsafe-inline/eval; module tests cannot prove paint or CSP.
// Escape-dense TUI bytes stress transport; read exact transcript through real selection/Copy/onSelectionCopy path.
// Scratch route mounts terminal without scripting session’s full host handshake.

const bundles = mobileWebAppDependenciesPresent()
const describeRender = bundles ? describe : describe.skip

let fixture = null
let controlCspViolations = []
const stream = escapeDenseStream()
const openPage = (pathname, options) => fixture.openPage(pathname, options)
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

// Subtract control CSP violations to attribute terminal’s own effects.
async function terminalCspViolations(page) {
  const seen = await page.evaluate(() => globalThis.__orcaCspViolations)
  const shared = new Set(controlCspViolations.map(stripAssetPath))
  return seen.map(stripAssetPath).filter((entry) => !shared.has(entry))
}

// Normalize per-run port/content-hash asset names out of findings.
function stripAssetPath(entry) {
  return entry.replace(/ @ .*$/, '')
}

describeRender(
  'the terminal on the page',
  () => {
    it('records what the page refuses before any terminal is on it', async () => {
      // Run control first and require marker paint before subtracting it; unmounted control cannot validate zero terminal violations.
      const { page } = await openPage(CONTROL_ROUTE)
      await page.waitForFunction(() => globalThis.__orcaTerminalControlMounted === true, {
        timeout: 60_000,
        polling: 100
      })
      controlCspViolations = await page.evaluate(() => globalThis.__orcaCspViolations)
      console.log('[c7.5][csp-control]', JSON.stringify(controlCspViolations.map(stripAssetPath)))
      // Control is now clean after jitless banner stopped Zod’s swallowed new Function probe; keep subtraction for terminal-specific attribution.
      expect(controlCspViolations.map(stripAssetPath)).toEqual([])
      await page.close()
    }, 300_000)

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

    it('installs no window.onerror on a page that had none', async () => {
      // With no initial handler, dispose must leave slot free for later consumer.
      const { page } = await openTerminal()
      expect(await page.evaluate(() => window.onerror)).toBe(null)
      await openProbeTerminal(page)
      expect(await page.evaluate(() => window.onerror)).toBe(null)
      await page.evaluate(() => globalThis.__orcaTerminalProbe.setMounted(false))
      await page.locator('#terminal-container').waitFor({ state: 'detached', timeout: 30_000 })
      expect(await page.evaluate(() => window.onerror)).toBe(null)
      await page.close()
    }, 300_000)

    // ES module bodies run once; remount must reacquire live DOM/listeners rather than retain detached first-mount elements.
    // Read live behavior: component readiness handshake alone does not prove engine uses current nodes.
    /** The listeners the page holds with no terminal on it, which is what two mounts can differ by. */
    async function listenersWithNoTerminal(page) {
      await page.evaluate(() => globalThis.__orcaTerminalProbe.setMounted(false))
      await page.locator('#terminal-container').waitFor({ state: 'detached', timeout: 30_000 })
      return page.evaluate(() => globalThis.__orcaListeners.snapshot())
    }

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

    it('is a live terminal again after an unmount and a remount', async () => {
      const { page } = await openTerminal()
      await openProbeTerminal(page)
      await assertLiveTerminal(page, 'first-mount')

      await page.evaluate(() => globalThis.__orcaTerminalProbe.setMounted(false))
      await page.locator('#terminal-container').waitFor({ state: 'detached', timeout: 30_000 })
      await page.evaluate(() => {
        globalThis.__orcaTerminalReady = false
        globalThis.__orcaTerminalProbe.setMounted(true)
      })
      await page.waitForFunction(() => globalThis.__orcaTerminalReady === true, {
        timeout: 60_000,
        polling: 100
      })
      await openProbeTerminal(page)
      await assertLiveTerminal(page, 'remount')
      await page.close()
    }, 300_000)

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

    it('leaves the page the listeners it found, across a mount and a dispose', async () => {
      // Compare listener snapshots after two unmounted cycles: component provides no bare-page moment, and a leak must grow on second cycle.
      // Include window/document resize, error, gesture and tap listeners; retained listeners may have no visible immediate failure.
      const { page } = await openTerminal({ listeners: true })
      await openProbeTerminal(page)
      const before = await listenersWithNoTerminal(page)
      await page.evaluate(() => {
        globalThis.__orcaTerminalReady = false
        globalThis.__orcaTerminalProbe.setMounted(true)
      })
      await page.waitForFunction(() => globalThis.__orcaTerminalReady === true, {
        timeout: 60_000,
        polling: 100
      })
      await openProbeTerminal(page)
      const whileLive = await page.evaluate(() => globalThis.__orcaListeners.snapshot())
      const after = await listenersWithNoTerminal(page)

      // Require recorder observed listener installs or empty baseline could pass leak equality.
      expect(whileLive, 'the mount installed listeners the dispose has to take back').not.toEqual(
        before
      )
      expect(after).toEqual(before)
      await page.close()
    }, 300_000)

    it('still reports runtime errors after a first mount spent the non-fatal budget', async () => {
      // Nonfatal error cap is per document instance: first mount spending five notifications must not mute replacement.
      const { page } = await openTerminal()
      await openProbeTerminal(page)
      await page.evaluate(() => {
        for (let index = 0; index < 6; index++) {
          setTimeout(() => {
            throw new Error(`orca-budget-burn-${String(index)}`)
          }, 0)
        }
      })
      await page.waitForFunction(
        () =>
          globalThis.__orcaTerminalEngineErrors.filter((entry) =>
            entry.includes('orca-budget-burn')
          ).length >= 5,
        { timeout: 30_000, polling: 100 }
      )

      await page.evaluate(() => globalThis.__orcaTerminalProbe.setMounted(false))
      await page.locator('#terminal-container').waitFor({ state: 'detached', timeout: 30_000 })
      await page.evaluate(() => {
        globalThis.__orcaTerminalReady = false
        globalThis.__orcaTerminalProbe.setMounted(true)
      })
      await page.waitForFunction(() => globalThis.__orcaTerminalReady === true, {
        timeout: 60_000,
        polling: 100
      })
      await openProbeTerminal(page)

      await page.evaluate(() => {
        globalThis.__orcaTerminalEngineErrors = []
        setTimeout(() => {
          throw new Error('orca-second-mount-error')
        }, 0)
      })
      await page.waitForFunction(
        () =>
          globalThis.__orcaTerminalEngineErrors.some((entry) =>
            entry.includes('orca-second-mount-error')
          ),
        { timeout: 30_000, polling: 100 }
      )
      await page.close()
    }, 300_000)

    it('cancels the timers it armed, so none of the first mount fires into the second', async () => {
      // Disposed timers/frames must not act on replacement; test each on its own witness.
      // Attribute schedules to document chunk identified by host-notify literal; xterm renderer owns unrelated harmless callbacks.
      let documentChunk = null
      const { page } = await openPage(PROBE_ROUTE, {
        scheduler: true,
        beforeNavigate: async (opened) => {
          await opened.route('**/*.js', async (route) => {
            const response = await route.fetch()
            const body = await response.text()
            if (body.includes('terminal runtime error')) {
              documentChunk = new URL(route.request().url()).pathname
            }
            await route.fulfill({ response, body })
          })
        }
      })
      await page.waitForFunction(() => globalThis.__orcaTerminalReady === true, {
        timeout: 60_000,
        polling: 100
      })
      await openProbeTerminal(page)
      expect(documentChunk, 'the document was served as its own chunk').not.toBe(null)
      // Arm document’s 550ms scroll-indicator timer, smooth-scroll frame and 500ms long-press in disposal task.
      // Long-press needs no engine paint; precondition proves provocation landed without racing renderer.
      await page.evaluate(() => {
        globalThis.__orcaScheduler.watching = true
        const surface = document.getElementById('terminal-surface')
        surface.dispatchEvent(
          new TouchEvent('touchstart', {
            bubbles: true,
            cancelable: true,
            touches: [new Touch({ identifier: 1, target: surface, clientX: 100, clientY: 400 })],
            changedTouches: [
              new Touch({ identifier: 1, target: surface, clientX: 100, clientY: 400 })
            ]
          })
        )
        globalThis.__orcaTerminalProbe.setMounted(false)
      })
      await page.locator('#terminal-container').waitFor({ state: 'detached', timeout: 30_000 })
      await page.evaluate(() => {
        globalThis.__orcaTerminalReady = false
        globalThis.__orcaTerminalProbe.setMounted(true)
      })
      await page.waitForFunction(() => globalThis.__orcaTerminalReady === true, {
        timeout: 60_000,
        polling: 100
      })
      await openProbeTerminal(page)
      // Wait beyond longest first-mount timer so surviving work would execute.
      await page.evaluate(() => new Promise((resolve) => globalThis.setTimeout(resolve, 3000)))
      const scheduler = await page.evaluate(() => globalThis.__orcaScheduler)
      // Require pending work existed or empty leak list proves nothing.
      expect(
        scheduler.scheduled.filter(
          (entry) => entry.owned && entry.kind === 'timer' && entry.caller.includes(documentChunk)
        ).length
      ).toBeGreaterThan(0)
      expect(
        scheduler.leaked.filter(
          (entry) => entry.startsWith('timer ') && entry.includes(documentChunk)
        )
      ).toEqual([])
      await page.unrouteAll({ behavior: 'ignoreErrors' })
      await page.close()
    }, 300_000)

    it.each([
      { name: 'takes back the frames it is owed, not only the timers', cancelFrames: true },
      { name: 'detects leaked frames when disposal cannot cancel them', cancelFrames: false }
    ])(
      '$name',
      async ({ cancelFrames }) => {
        // Hold real refit frame across disposal so ResizeObserver cannot race witness.
        let documentChunk = null
        const { page } = await openPage(PROBE_ROUTE, {
          scheduler: true,
          beforeNavigate: async (opened) => {
            await opened.route('**/*.js', async (route) => {
              const response = await route.fetch()
              const body = await response.text()
              if (body.includes('terminal runtime error')) {
                documentChunk = new URL(route.request().url()).pathname
              }
              await route.fulfill({ response, body })
            })
          }
        })
        try {
          await page.waitForFunction(() => globalThis.__orcaTerminalReady === true, {
            timeout: 60_000,
            polling: 100
          })
          await openProbeTerminal(page)
          expect(documentChunk, 'the document was served as its own chunk').not.toBe(null)
          // Settle ready’s pending replay-fit first; otherwise it consumes resize before observer can schedule frame under test.
          await page.evaluate(
            () =>
              new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
          )

          await page.evaluate((chunk) => {
            const state = globalThis.__orcaScheduler
            state.disposed = null
            state.watching = true
            state.holdFramesFrom = chunk
            const host = document.querySelector('.orca-terminal-document-host')
            // Dispose removes class after cancelling frames; DOM detachment occurs before cleanup.
            const observer = new MutationObserver(() => {
              if (
                state.disposed !== null ||
                host.classList.contains('orca-terminal-document-host')
              ) {
                return
              }
              state.disposed = {
                owed: state.scheduled.filter(
                  (entry) => entry.kind === 'frame' && !entry.fired && entry.caller.includes(chunk)
                ).length,
                leakedBefore: state.leaked.length
              }
              observer.disconnect()
            })
            observer.observe(host, { attributes: true, attributeFilter: ['class'] })
            host.style.width = '80%'
          }, documentChunk)
          await page.waitForFunction(() => globalThis.__orcaScheduler.heldFrames > 0, undefined, {
            timeout: 30_000
          })
          await page.evaluate((cancelFrames) => {
            globalThis.__orcaRestoreFrameCancellation = globalThis.cancelAnimationFrame
            if (!cancelFrames) {
              // Negative control must expose held callbacks after real document disposal.
              globalThis.cancelAnimationFrame = () => {}
            }
            globalThis.__orcaTerminalProbe.setMounted(false)
          }, cancelFrames)
          await page.locator('#terminal-container').waitFor({ state: 'detached', timeout: 30_000 })
          await page.waitForFunction(() => globalThis.__orcaScheduler.disposed !== null)
          await page.evaluate(() => {
            globalThis.cancelAnimationFrame = globalThis.__orcaRestoreFrameCancellation
            globalThis.__orcaScheduler.holdFramesFrom = null
            globalThis.__orcaTerminalReady = false
            globalThis.__orcaTerminalProbe.setMounted(true)
          })
          await page.waitForFunction(() => globalThis.__orcaTerminalReady === true, {
            timeout: 60_000,
            polling: 100
          })
          await openProbeTerminal(page)
          // Require uncancelled work runs on replacement; hold mechanism must not itself hide leaks.
          await page.evaluate(
            () =>
              new Promise((resolve) => {
                globalThis.__orcaReleaseFrames()
                requestAnimationFrame(() => requestAnimationFrame(resolve))
              })
          )

          const scheduler = await page.evaluate(() => globalThis.__orcaScheduler)
          expect(
            scheduler.disposed?.owed,
            'the document owed a frame at the moment dispose returned'
          ).toBeGreaterThan(0)
          const leakedFrames = scheduler.leaked
            .slice(scheduler.disposed.leakedBefore)
            .filter((entry) => entry.startsWith('frame ') && entry.includes(documentChunk))
          if (cancelFrames) {
            expect(leakedFrames).toEqual([])
          } else {
            expect(
              leakedFrames.length,
              'the recorder must expose uncancelled work'
            ).toBeGreaterThan(0)
          }
        } finally {
          await page.unrouteAll({ behavior: 'ignoreErrors' }).finally(() => page.close())
        }
      },
      300_000
    )

    it('styles what it owns, and only that', async () => {
      // WebView sheet owns *, html and body, but page terminal owns only its host: omit document rules and scope remaining selectors.
      // Compare same app without terminal; unscoped rules would alter all screens even after terminal disposal.
      const control = await openPage(CONTROL_ROUTE)
      const expected = await readRootComputedStyles(control.page)
      await control.page.close()

      const { page } = await openTerminal()
      await openProbeTerminal(page)
      expect(await readRootComputedStyles(page), 'roots while the terminal is mounted').toEqual(
        expected
      )

      // Check every selector stays under host; body-only comparison misses other escaped targets.
      const mounted = await terminalStyleReach(page)
      // Require stylesheet rules exist so empty sheet cannot pass scoping checks.
      expect(mounted.rules).toBeGreaterThan(0)
      expect(mounted.outside).toEqual([])

      // Positive control reads live xterm/document styles; sheet matching nothing would satisfy all isolation checks.
      expect(
        await page.evaluate(() => {
          const host = document.querySelector('.orca-terminal-document-host')
          const xterm = host.querySelector('.xterm')
          const viewport = host.querySelector('.xterm-viewport')
          const overlay = host.querySelector('#selection-overlay')
          return {
            xtermPosition: getComputedStyle(xterm).position,
            // Terminal owns scrolling; viewport must not reserve width for browser scrollbar.
            viewportOverflowY: getComputedStyle(viewport).overflowY,
            viewportReservesScrollbar: viewport.offsetWidth !== viewport.clientWidth,
            // Overlay uses host-local unscaled coordinates; fixed would cover page header.
            overlayPosition: getComputedStyle(overlay).position
          }
        })
      ).toEqual({
        xtermPosition: 'relative',
        viewportOverflowY: 'hidden',
        viewportReservesScrollbar: false,
        overlayPosition: 'absolute'
      })

      await page.evaluate(() => globalThis.__orcaTerminalProbe.setMounted(false))
      await page.locator('#terminal-container').waitFor({ state: 'detached', timeout: 30_000 })
      expect(await readRootComputedStyles(page), 'roots after dispose').toEqual(expected)
      // Retain stylesheet across mounts; without host it must match nothing.
      const disposed = await terminalStyleReach(page)
      expect(disposed.rules).toBe(mounted.rules)
      expect(disposed.outside).toEqual([])
      await page.close()
    }, 300_000)

    it('fits through the handle from the ready box and records what beforeinput reports', async () => {
      const { page } = await openTerminal()
      await openProbeTerminal(page)

      // Fit uses actual cell box from web-ready and RN frame; null means missing/too-small measurable grid.
      const fit = await page.evaluate(() => globalThis.__orcaTerminalProbe.fit())
      expect(fit).not.toBeNull()
      expect(fit.cols).toBeGreaterThanOrEqual(20)
      expect(fit.rows).toBeGreaterThanOrEqual(8)

      // xterm helper textarea is readonly/untabbable/inputmode-none; keyboard input belongs to screen field tested below.
      const textarea = await page.evaluate(() => {
        const element = document.querySelector('#terminal-surface .xterm-helper-textarea')
        return element === null
          ? null
          : {
              readOnly: element.readOnly,
              tabIndex: element.tabIndex,
              inputMode: element.getAttribute('inputmode')
            }
      })
      expect(textarea).toEqual({ readOnly: true, tabIndex: -1, inputMode: 'none' })

      // Browser covers ordinary text entry; real composing soft-keyboard behavior remains device proof.
      await page.getByTestId('terminal-live-input').focus()
      await page.keyboard.type('ab')
      await page.waitForFunction(() => globalThis.__orcaTerminalBeforeInput.length >= 2, {
        timeout: 30_000,
        polling: 100
      })
      const beforeInput = await page.evaluate(() => globalThis.__orcaTerminalBeforeInput)
      console.log('[c7.5][beforeinput]', JSON.stringify(beforeInput.slice(0, 4)))
      expect(beforeInput.map((entry) => entry.inputType)).toContain('insertText')
      expect(beforeInput.map((entry) => entry.data)).toContain('a')
      expect(beforeInput.every((entry) => entry.isComposing === false)).toBe(true)
      expect(await terminalCspViolations(page)).toEqual([])
      await page.close()
    }, 300_000)
  },
  900_000
)

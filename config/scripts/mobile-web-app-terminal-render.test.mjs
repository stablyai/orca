import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import {
  escapeDenseStream,
  FIRST_MARKER,
  LAST_MARKER,
  MIN_STREAM_BYTES
} from './mobile-web-app-terminal-probe-route.mjs'
import {
  CONTROL_ROUTE,
  openProbeTerminal,
  PROBE_ROUTE,
  startTerminalRenderFixture
} from './mobile-web-app-terminal-render-fixture.mjs'
import { readRootComputedStyles, terminalStyleReach } from './mobile-web-app-render-harness.mjs'

/**
 * The page's terminal, in a real browser, under the policy the shell sends.
 *
 * Everything below the contract is new on the page: xterm is an import rather than a 612 KiB
 * string in a WebView document, the document's modules run in the page's own realm, and the
 * stylesheet and the elements they read by id are planted by the component. None of that is
 * settled by a module test. What a browser settles is whether it opens at all under
 * `script-src 'self'` with no `unsafe-inline` and no `unsafe-eval`, whether a real terminal byte
 * stream reaches the buffer intact, and whether anything the page does is refused by the policy.
 *
 * The stream is deliberately escape-dense: colour changes, cursor moves and erases at every cell
 * boundary, which is the shape that expands worst through the transport and the shape a TUI
 * actually paints. It is read back through the document's own selection path — select all, then
 * the Copy button the overlay carries — so the oracle is the component's `onSelectionCopy` prop
 * and not a private reach into xterm.
 *
 * No route serves this screen until C7.7, so the component is bundled through a scratch route
 * tree. That step retires the moment the session route is registered.
 */

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

/** Violations this page recorded that the control did not, which is the terminal's own account. */
async function terminalCspViolations(page) {
  const seen = await page.evaluate(() => globalThis.__orcaCspViolations)
  const shared = new Set(controlCspViolations.map(stripAssetPath))
  return seen.map(stripAssetPath).filter((entry) => !shared.has(entry))
}

/** The asset name is a content hash and the port is per run; neither is part of the finding. */
function stripAssetPath(entry) {
  return entry.replace(/ @ .*$/, '')
}

describeRender(
  'the terminal on the page',
  () => {
    it('records what the page refuses before any terminal is on it', async () => {
      // Run first, and the two cases below subtract it, so their zero is the terminal's own
      // account rather than the bundle's. A control that mounted nothing would report nothing for
      // the wrong reason, so the route's own marker is the precondition.
      const { page } = await openPage(CONTROL_ROUTE)
      await page.waitForFunction(() => globalThis.__orcaTerminalControlMounted === true, {
        timeout: 60_000,
        polling: 100
      })
      controlCspViolations = await page.evaluate(() => globalThis.__orcaCspViolations)
      console.log('[c7.5][csp-control]', JSON.stringify(controlCspViolations.map(stripAssetPath)))
      // Nothing, which is a stronger fact than this case was built for. It first read
      // `script-src: eval` — Zod probing for a JIT with `new Function` and swallowing the throw,
      // so no page error and no console line reported it — and main's jitless banner closed that
      // before this branch merged it. The subtraction stays: it is what makes the cases below say
      // "the terminal added none" rather than "none were seen".
      expect(controlCspViolations.map(stripAssetPath)).toEqual([])
      await page.close()
    }, 300_000)

    it('opens xterm under the shipped policy and paints a dense stream into its buffer', async () => {
      const { errors, page } = await openTerminal()
      await openProbeTerminal(page)
      const applied = await page.evaluate((data) => {
        globalThis.__orcaTerminalProbe.write(data)
        return data.length
      }, stream)
      expect(applied).toBeGreaterThanOrEqual(MIN_STREAM_BYTES)

      // Read back through the document's own path: select all, then the overlay's Copy button,
      // which posts the buffer text to the component's onSelectionCopy prop.
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
      // The escapes were consumed by the parser rather than printed as text.
      expect(copied).not.toContain('\u001b')
      expect(copied).not.toContain('[31;1m')

      expect(await terminalCspViolations(page)).toEqual([])
      expect(await page.evaluate(() => globalThis.__orcaTerminalEngineErrors)).toEqual([])
      expect(errors).toEqual([])
      await page.close()
    }, 300_000)

    it('leaves the page its own window.onerror across mount and dispose', async () => {
      // The page installs a handler before the bundle loads, so the terminal meets one that is
      // not its to take. Identity is checked in the page: the same function object at all three
      // points, not merely a non-null one and not merely the same shape.
      const { page } = await openTerminal({ errorSentinel: true })
      expect(await page.evaluate(() => window.onerror === globalThis.__orcaSentinel)).toBe(true)
      await openProbeTerminal(page)
      expect(await page.evaluate(() => window.onerror === globalThis.__orcaSentinel)).toBe(true)

      // Both reporters see the same uncaught error: the page keeps the one it installed, and the
      // terminal's own listener still works. Without the second half the readings above would
      // pass on a terminal that had simply stopped reporting.
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

      // Dispose takes the terminal's listener off and leaves the page's handler where it was.
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
      // The page's handler saw it and the terminal's did not, which is what dispose has to mean.
      expect(await page.evaluate(() => globalThis.__orcaTerminalEngineErrors.length)).toBe(before)
      await page.close()
    }, 300_000)

    it('installs no window.onerror on a page that had none', async () => {
      // The other half: with nothing installed the terminal must not leave one behind either, so
      // a later consumer still finds the slot free.
      const { page } = await openTerminal()
      expect(await page.evaluate(() => window.onerror)).toBe(null)
      await openProbeTerminal(page)
      expect(await page.evaluate(() => window.onerror)).toBe(null)
      await page.evaluate(() => globalThis.__orcaTerminalProbe.setMounted(false))
      await page.locator('#terminal-container').waitFor({ state: 'detached', timeout: 30_000 })
      expect(await page.evaluate(() => window.onerror)).toBe(null)
      await page.close()
    }, 300_000)

    /**
     * A terminal that is mounted, taken down and mounted again has to be a terminal again.
     *
     * The document's modules are ES modules: their bodies run once per page, so anything they did
     * as they were parsed — reading their elements by id, installing the error reporter, adding
     * listeners — a second mount would inherit from the first, pointing at elements that are no
     * longer in the document. Nothing above the contract would notice: `onWebReady` still fires,
     * because readiness is the component's own handshake and not a claim about the engine.
     *
     * So the assertions are about the live DOM and the live paths, not about readiness.
     */
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

      // The selection overlay is the document's own element, reached through the handle: it only
      // activates if `handleMsg` is talking to the elements that are actually on the page.
      await page.evaluate(() => globalThis.__orcaTerminalProbe.selectAll())
      await page.waitForFunction(
        () => document.getElementById('selection-overlay')?.classList.contains('active') === true,
        { timeout: 30_000, polling: 100 }
      )

      // And the reporter, which is the seam that is installed once per mount.
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
      // The other way a second mount happens, and the one a user reaches: the terminal fails
      // before it is ready, the engine-error overlay appears, and Reload disposes the document
      // and builds another inside the same component. Driven end to end rather than by calling
      // the handler — an uncaught error before the first `init` is fatal by the document's own
      // rule, which is what puts the overlay on screen.
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
      // Ruling 20 moved every install into a start function and ruling 21 gave each one a stop,
      // and the document installs on `window` and `document` both: the resize refit, the error
      // reporter, the tap and gesture listeners the surface modules arm. A stop that forgets one
      // does not fail anything visible — the next mount simply adds a second copy, and the page
      // accumulates a listener per terminal it has ever shown.
      //
      // The comparison is drawn across a second mount rather than against the bare page: the
      // component mounts as the route does, so there is no moment before the first terminal to
      // photograph. Both readings are taken with no terminal on the page, so a mount that leaks
      // once leaks again and the two disagree.
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

      // The precondition: a mount that installed nothing would satisfy the equality below for
      // exactly the reason the case exists to refuse.
      expect(whileLive, 'the mount installed listeners the dispose has to take back').not.toEqual(
        before
      )
      expect(after).toEqual(before)
      await page.close()
    }, 300_000)

    it('still reports runtime errors after a first mount spent the non-fatal budget', async () => {
      // Ruling 21's finding, end to end. `reportEngineError` caps non-fatal notifies at five so a
      // per-frame thrower cannot flood the host. That counter is the document's, not the mount's:
      // a first terminal that spends it leaves the second one mute, reporting nothing however it
      // fails, while every other signal — readiness, paint, selection — says the terminal is fine.
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
      // The other half of the same rule. A timer the first terminal armed has no owner after
      // dispose, and on the second mount it acts on the terminal that replaced it — hiding an
      // indicator nobody raised. Frames are the case below, which provokes them deliberately;
      // each asserts on its own witness so neither can stand in for the other.
      // The document is its own chunk, and the point is what *it* scheduled: xterm's renderer
      // schedules frames of its own that a disposed terminal simply ignores, and the browser
      // cannot unschedule those. So the chunk is identified on the wire, by a literal only
      // `host-notify` carries, and a leak is a callback that chunk scheduled.
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
      // Enough rows for a scrollback, so the wheel below reveals the scroll indicator: that is
      // the document's longest-lived piece of scheduled work, a 550 ms timer to hide it again,
      // which outlives an unmount even on a loaded machine. The same wheel leaves the
      // smooth-scroll frame owed. Both are asked for in the task that tells the component to go.
      // One touch on the surface arms the long-press timer: 500 ms, held on the scope, cancelled
      // by `stopTapDispatch`. It is the document's own timer and it needs nothing rendered, so
      // the provocation cannot race the engine — the precondition below says whether it landed.
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
      // Long enough for the slowest timer of the first mount to have fired if it survived.
      await page.evaluate(() => new Promise((resolve) => globalThis.setTimeout(resolve, 3000)))
      const scheduler = await page.evaluate(() => globalThis.__orcaScheduler)
      // The precondition: there was something to leak. A wheel that reached nothing would agree
      // with the empty list below for the wrong reason.
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

    it('takes back the frames it is owed, not only the timers', async () => {
      // The timer case above is witnessed by a 550 ms timeout, which every module's own stop
      // cancels by the handle the scope holds. A frame is the other shape: `applyFitScale` asks
      // for one through the scope's registry and never holds its id, so `stopFitScale` can only
      // bump the token it tests itself against — the frame still runs. Nothing but
      // `cancelDocumentFrames` takes it back.
      //
      // Two things have to be pinned down for that to be readable, and the first version of this
      // case had neither.
      //
      // The witness has to be owed at the instant dispose is called, whoever drives the refit: a
      // resize observer here, the host's layout notify elsewhere, and neither owes a frame at the
      // end of every frame — a refit that finds its box already fitted asks for none. So the test
      // reads the owed count from a frame of its own and, once it is positive, unmounts with a
      // sync render in that same callback. Detach and dispose then run before it returns, with no
      // gap a frame could be served in, so the leak is counted from the moment dispose returned.
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

      await page.evaluate((chunk) => {
        const state = globalThis.__orcaScheduler
        state.disposed = null
        state.watching = true
        const host = document.querySelector('.orca-terminal-document-host')
        const owedFrames = () =>
          state.scheduled.filter(
            (entry) =>
              entry.kind === 'frame' &&
              !entry.fired &&
              !entry.cancelled &&
              entry.caller.includes(chunk)
          ).length
        // The page's refit follows the host's box, not the window, so the pulse resizes the host.
        let narrow = false
        let frames = 0
        const disposeWhenOwed = () => {
          const owed = owedFrames()
          if (owed === 0 && ++frames < 600) {
            narrow = !narrow
            host.style.width = narrow ? '99%' : ''
            requestAnimationFrame(disposeWhenOwed)
            return
          }
          const leakedBefore = state.leaked.length
          globalThis.__orcaTerminalProbe.unmountNow()
          // `dispose` drops the host's class last, so its absence says dispose ran inside the call.
          const returned = !host.classList.contains('orca-terminal-document-host')
          state.disposed = { owed, leakedBefore, returned }
        }
        requestAnimationFrame(disposeWhenOwed)
      }, documentChunk)
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
      await page.evaluate(() => new Promise((resolve) => globalThis.setTimeout(resolve, 3000)))

      const scheduler = await page.evaluate(() => globalThis.__orcaScheduler)
      expect(scheduler.disposed?.returned, 'dispose ran inside the unmount call').toBe(true)
      expect(
        scheduler.disposed.owed,
        'the document owed a frame at the moment dispose was called'
      ).toBeGreaterThan(0)
      expect(
        scheduler.leaked
          .slice(scheduler.disposed.leakedBefore)
          .filter((entry) => entry.startsWith('frame ') && entry.includes(documentChunk))
      ).toEqual([])
      await page.unrouteAll({ behavior: 'ignoreErrors' })
      await page.close()
    }, 300_000)

    it('styles what it owns, and only that', async () => {
      // The document's sheet says `*`, `html` and `body` because inside a WebView it owns the
      // page. Appended to the head of a React Native Web application it owns nothing: those three
      // selectors set the application's background, its overflow and every element's box model,
      // on every screen the shell can show, and go on doing it after the terminal is gone.
      //
      // Ruling 19's shape: the page mount may style only what it owns. So the document-level
      // rules are never injected and every remaining selector is held under the host's class.
      // The oracle is a page of the same application with no terminal on it.
      const control = await openPage(CONTROL_ROUTE)
      const expected = await readRootComputedStyles(control.page)
      await control.page.close()

      const { page } = await openTerminal()
      await openProbeTerminal(page)
      expect(await readRootComputedStyles(page), 'roots while the terminal is mounted').toEqual(
        expected
      )

      // And nothing in the sheet reaches past the host, which is the rule the comparison above
      // cannot see: a selector that matched something outside would not have to change `body`.
      const mounted = await terminalStyleReach(page)
      // The precondition: there are rules to escape with.
      expect(mounted.rules).toBeGreaterThan(0)
      expect(mounted.outside).toEqual([])

      // The positive half, which the two above cannot give: a sheet that reached nothing at all
      // would satisfy both of them. These are four things the terminal looks like only because
      // the rules arrive — one from xterm's sheet, three from the document's own — read off the
      // live elements rather than off the stylesheet text.
      expect(
        await page.evaluate(() => {
          const host = document.querySelector('.orca-terminal-document-host')
          const xterm = host.querySelector('.xterm')
          const viewport = host.querySelector('.xterm-viewport')
          const overlay = host.querySelector('#selection-overlay')
          return {
            // xterm's own sheet: the grid is positioned against this, and its rows are absolute.
            xtermPosition: getComputedStyle(xterm).position,
            // The document's: the terminal scrolls itself, so the viewport shows no scrollbar
            // and reserves no width for one.
            viewportOverflowY: getComputedStyle(viewport).overflowY,
            viewportReservesScrollbar: viewport.offsetWidth !== viewport.clientWidth,
            // The mount's: the overlay sits in the host's unscaled coordinates above the grid,
            // not over the page's header as `fixed` would put it.
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
      // The sheet stays in the head for the next mount, and matches nothing until there is one.
      const disposed = await terminalStyleReach(page)
      expect(disposed.rules).toBe(mounted.rules)
      expect(disposed.outside).toEqual([])
      await page.close()
    }, 300_000)

    it('measures a fit through the handle and records what beforeinput reports', async () => {
      const { page } = await openTerminal()
      await openProbeTerminal(page)

      // The handle's own round trip: a measure is a command in and a notify back, and on the page
      // both halves are direct calls rather than a bridge. Null would mean the document answered
      // nothing, or answered a grid too small to fit.
      const fit = await page.evaluate(() => globalThis.__orcaTerminalProbe.measure())
      expect(fit).not.toBeNull()
      expect(fit.cols).toBeGreaterThanOrEqual(20)
      expect(fit.rows).toBeGreaterThanOrEqual(8)

      // xterm's own textarea is inert by the document's design — `query-reply.ts` makes it
      // read-only, untabbable and `inputmode=none` so touch and hardware keys go to the screen's
      // input instead. Asserted rather than assumed, because it is why the probe below types
      // somewhere else.
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

      // Design §8's cheap half of the IME question: what a browser reports for text entering a
      // terminal on the page, which arrives at the screen's own input. A composing IME on a real
      // soft keyboard is the device step, which this does not claim to answer.
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

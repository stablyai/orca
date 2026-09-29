import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium } from 'playwright-core'
import { buildMobileWebAppBundle } from './build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import {
  BUFFERED_FIELD_ID,
  LIVE_INPUT_FIELD_ID,
  liveInputProbeRouteSource
} from './mobile-web-app-live-input-probe-route.mjs'
import { MOBILE_WEB_APP_ROUTE_ROOT } from './mobile-web-app-route-manifest.mjs'
import {
  createBundleServer,
  installShellDouble,
  readBridgeFaultGrant,
  readBridgeProtocolVersion,
  readShellCsp
} from './mobile-web-app-render-harness.mjs'
import { LAYOUT_SOURCE } from './mobile-web-app-terminal-probe-route.mjs'

/**
 * The terminal's live input, in a real browser, on the bundle the shell would serve.
 *
 * What only a browser answers: that the writes the live-input hooks make against
 * `liveInputRef.current` are writes React Native Web can honour. Natively the ref is a host
 * component with `setNativeProps`; on the page it is the DOM node, which has no such method, so
 * the call is a `TypeError` thrown from a mount effect — the page faults, the shell tears the view
 * down, and the session route comes up with a 0x0 terminal and a keyboard that never opens.
 *
 * **Why `mobile-web-app-session-render.test.mjs` is green on the same defect.** It opens the real
 * session route with a shell double that answers no RPC, so the screen has no tab snapshot and no
 * terminal inventory, so `activeHandle` stays null and `liveInputEnabled` is false. The field the
 * ref points at is inside that branch and never renders, `liveInputRef.current` is null, and
 * `liveInputRef.current?.setNativeProps(...)` is skipped by its own optional chain. The check's
 * error list is exactly empty for a page that never made the call. Its two siblings —
 * `mobile-web-app-session-text-inputs.test.mjs` and `mobile-web-app-session-media-picker.test.mjs`
 * — are source censuses over the route closure and mount nothing at all.
 *
 * So this file gives the hooks the one thing that route cannot: a mounted field. Everything else
 * is the page as shipped — the real bundler, the real module resolution (a `.web.ts` sibling wins
 * here exactly as it would on a registered route), the shell's own policy header, and the page's
 * own `PageFaultBoundary` reporting through the bridge.
 */

const PROBE_ROUTE = `/${MOBILE_WEB_APP_ROUTE_ROOT}/live-input-probe`
const SHELL_HOST = {
  id: 'live-input-host',
  name: 'Live Input Host',
  endpoint: 'ws://live-input',
  lastConnected: 1
}

const bundles = mobileWebAppDependenciesPresent()
const describeRender = bundles ? describe : describe.skip

let browser = null
let origin = null
let scratch = null
let server = null
let bridgeVersion = null
let faultGrant = null

beforeAll(async () => {
  if (!bundles) {
    return
  }
  const projectDir = fileURLToPath(new URL('../..', import.meta.url))
  const terminalDir = join(projectDir, 'mobile', 'src', 'terminal')
  const cspHeader = await readShellCsp()
  bridgeVersion = await readBridgeProtocolVersion()
  faultGrant = await readBridgeFaultGrant()
  scratch = await mkdtemp(join(tmpdir(), 'orca-mobile-web-live-input-'))
  const appDir = join(scratch, 'app')
  const routeDir = join(appDir, MOBILE_WEB_APP_ROUTE_ROOT)
  await mkdir(routeDir, { recursive: true })
  await writeFile(join(routeDir, '_layout.tsx'), LAYOUT_SOURCE)
  // Extensionless, so the bundler picks a `.web.ts` sibling exactly as it would for a real route.
  await writeFile(
    join(routeDir, 'live-input-probe.tsx'),
    liveInputProbeRouteSource({
      bindingModule: join(terminalDir, 'use-terminal-text-field-submit-binding'),
      commitModule: join(terminalDir, 'use-terminal-live-input-commit'),
      draftsModule: join(terminalDir, 'use-buffered-terminal-drafts')
    })
  )
  const built = await buildMobileWebAppBundle({
    appDir,
    outDir: join(scratch, 'bundle'),
    pageRoutes: [{ pathname: PROBE_ROUTE, grants: [] }]
  })
  const served = await createBundleServer({ outDir: built.outDir, cspHeader })
  server = served.server
  origin = served.origin
  const executablePath = process.env.ORCA_MOBILE_WEB_RENDER_BROWSER
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
}, 600_000)

afterAll(async () => {
  await browser?.close()
  server?.close()
  if (scratch) {
    await rm(scratch, { recursive: true, force: true })
  }
})

/**
 * Open the probe and wait for the route to settle either way.
 *
 * Settled is "the probe registered" or "the page reported a fault", because those are the two
 * outcomes and waiting only for the first turns the defect into a 60s timeout that names nothing.
 */
async function openProbe({ userAgent } = {}) {
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    ...(userAgent ? { userAgent } : {})
  })
  await page.addInitScript(installShellDouble, {
    version: bridgeVersion,
    sessionId: 'live-input-session',
    buildId: 'live-input-build',
    route: { pathname: PROBE_ROUTE, params: {} },
    host: SHELL_HOST,
    storage: {},
    faultGrant,
    grants: [faultGrant],
    pageRoutes: [PROBE_ROUTE],
    replies: {}
  })
  const errors = []
  page.on('pageerror', (error) => errors.push(`${error.name}: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(`console.error: ${message.text()}`)
    }
  })
  await page.goto(`${origin}/`, { waitUntil: 'load' })
  await page.waitForFunction(() => document.documentElement.dataset.orcaWebEntry === 'mounted', {
    timeout: 60_000,
    polling: 250
  })
  await page.waitForFunction(
    () =>
      globalThis.__orcaLiveInputProbe !== undefined ||
      (globalThis.__orcaRenderCheckFaults ?? []).length > 0,
    { timeout: 60_000, polling: 100 }
  )
  const faults = await page.evaluate(() => globalThis.__orcaRenderCheckFaults ?? [])
  return { errors, faults, page }
}

const fieldValue = (page) =>
  page.evaluate((id) => document.getElementById(id)?.value ?? null, LIVE_INPUT_FIELD_ID)

/** Typed text, as the field and the mirror both hold it once a native edit has landed. */
async function typeIntoField(page, text) {
  await page.evaluate((typed) => globalThis.__orcaLiveInputProbe.type(typed), text)
  await page.waitForFunction(
    ([id, typed]) => document.getElementById(id)?.value === typed,
    [LIVE_INPUT_FIELD_ID, text],
    { timeout: 30_000, polling: 100 }
  )
}

describeRender(
  'the terminal live input on the page',
  () => {
    it('mounts a session-startup clear without faulting the page', async () => {
      // The emulator's first line: `[web-shell] the page faulted { category: 'TypeError', message:
      // 'r.current?.setNativeProps is not a function' }`, then a torn-down view. The route's mount
      // effect is the same call from the same place, so an unhonourable write lands here.
      const { errors, faults, page } = await openProbe()
      expect(faults).toEqual([])
      expect(errors).toEqual([])
      expect(await fieldValue(page)).toBe('')
      await page.close()
    }, 300_000)

    it('writes the field itself, so a drifted value is cleared without a render', async () => {
      const { errors, page } = await openProbe()
      // The state the native write exists for: the DOM node holds text React's `value` prop does
      // not know about, which is where an IME leaves the field mid-composition. The capture state
      // is already '' here, so the clear below is a no-op for React — it re-renders nothing — and
      // the only thing that can empty the node is the write itself.
      await page.evaluate((id) => {
        document.getElementById(id).value = 'ime-preedit'
      }, LIVE_INPUT_FIELD_ID)
      expect(await fieldValue(page)).toBe('ime-preedit')

      await page.evaluate(() => globalThis.__orcaLiveInputProbe.clear())

      expect(await fieldValue(page)).toBe('')
      expect(errors).toEqual([])
      await page.close()
    }, 300_000)

    it('clears the field when Enter submits, the way it does natively', async () => {
      // The emulator's second page-only line: the command ran and the Live input row kept showing
      // the text that had just been sent. Keys go in through the browser because the thing under
      // test is react-native-web's keydown handler, which is what turns Enter into onSubmitEditing.
      const { errors, page } = await openProbe()
      await page.focus(`#${LIVE_INPUT_FIELD_ID}`)
      await page.keyboard.type('ls')
      await page.waitForFunction(
        (id) => document.getElementById(id)?.value === 'ls',
        LIVE_INPUT_FIELD_ID,
        { timeout: 30_000, polling: 100 }
      )

      await page.keyboard.press('Enter')

      await page.waitForFunction(
        () => (globalThis.__orcaLiveInputProbe.sent() ?? []).includes('\r'),
        undefined,
        { timeout: 30_000, polling: 100 }
      )
      // Exact, not `includes`: react-native-web cancels every keydown it submits on, so the page's
      // own line-break binding must stay silent here rather than send a second carriage return.
      expect(await page.evaluate(() => globalThis.__orcaLiveInputProbe.sent())).toEqual([
        'l',
        's',
        '\r'
      ])
      expect(await fieldValue(page)).toBe('')
      expect(errors).toEqual([])
      await page.close()
    }, 300_000)

    it('submits when Enter arrives with the keyboard composition still open', async () => {
      // The emulator's page-only defect. An Android soft keyboard holds a composition over the
      // word being typed, so the Enter keydown carries `isComposing: true` — and that is exactly
      // the condition react-native-web reads to decide `onSubmitEditing` must not fire. Native
      // Android has no such suppression: its editor action fires and the field clears.
      const { errors, page } = await openProbe()
      await page.focus(`#${LIVE_INPUT_FIELD_ID}`)
      const input = await page.context().newCDPSession(page)
      await input.send('Input.imeSetComposition', {
        text: 'ls',
        selectionStart: 2,
        selectionEnd: 2
      })
      await page.waitForFunction(
        (id) => document.getElementById(id)?.value === 'ls',
        LIVE_INPUT_FIELD_ID,
        { timeout: 30_000, polling: 100 }
      )

      await page.keyboard.press('Enter')

      // The held composition is committed to the terminal first, then the carriage return, which
      // is the order the native path produces for the same keystroke.
      await page.waitForFunction(
        () => globalThis.__orcaLiveInputProbe.sent().includes('\r'),
        undefined,
        { timeout: 30_000, polling: 100 }
      )
      expect(await page.evaluate(() => globalThis.__orcaLiveInputProbe.sent())).toEqual([
        'ls',
        '\r'
      ])
      expect(await fieldValue(page)).toBe('')
      expect(errors).toEqual([])
      await page.close()
    }, 300_000)

    it("clears the field when the key bar's Enter chip ends the line", async () => {
      // The device trace's variant (a), which is what shots/23 actually was: the chip emits no DOM
      // key event at all, so react-native-web's submit handling never runs and the accessory hook
      // is the only thing that could end the field's editing session. It did not, and the next
      // keystrokes appended to the text still sitting there.
      const { errors, page } = await openProbe()
      await page.focus(`#${LIVE_INPUT_FIELD_ID}`)
      await page.keyboard.type('ls')
      await page.waitForFunction(
        (id) => document.getElementById(id)?.value === 'ls',
        LIVE_INPUT_FIELD_ID,
        { timeout: 30_000, polling: 100 }
      )

      await page.evaluate(() => globalThis.__orcaLiveInputProbe.accessory({ bytes: '\r' }))

      // Exactly once, whichever branch carries it: the hook sends the control itself or defers to
      // the caller, and a fix that did both would double the command.
      await page.waitForFunction(
        () => (globalThis.__orcaLiveInputProbe.sent() ?? []).includes('\r'),
        undefined,
        { timeout: 30_000, polling: 100 }
      )
      expect(await page.evaluate(() => globalThis.__orcaLiveInputProbe.sent())).toEqual([
        'l',
        's',
        '\r'
      ])
      expect(await fieldValue(page)).toBe('')
      expect(errors).toEqual([])
      await page.close()
    }, 300_000)

    it('edits the field from the accessory bar and mirrors the erase to the terminal', async () => {
      // The second write site: an accessory Backspace is a local edit, so the hook writes the
      // shortened text into the field itself and the mirror diff sends the PTY erase. On the page
      // the write threw before the send, so the bar did nothing at all.
      const { errors, page } = await openProbe()
      await typeIntoField(page, 'ab')

      const result = await page.evaluate(() =>
        globalThis.__orcaLiveInputProbe.accessory({ bytes: '\u007f', localEdit: 'backspace' })
      )

      expect(result).toEqual({ kind: 'handled' })
      await page.waitForFunction(
        (id) => document.getElementById(id)?.value === 'a',
        LIVE_INPUT_FIELD_ID,
        { timeout: 30_000, polling: 100 }
      )
      // One DEL reached the terminal, so the field edit above is a mirror of the PTY rather than a
      // local edit that silently diverged from it.
      expect(await page.evaluate(() => globalThis.__orcaLiveInputProbe.sent())).toEqual([
        'ab',
        '\u007f'
      ])
      expect(errors).toEqual([])
      await page.close()
    }, 300_000)

    describe('under an Android keyboard, which composes every word it types', () => {
      // The OTA shell's WebView. Its keyboards hold a composing region over the Latin word being
      // typed, so every input event mid-word says `isComposing: true`; native Android reports no
      // range at all, and there each ASCII keystroke reaches the terminal as it is typed.
      const ANDROID_WEBVIEW_USER_AGENT =
        'Mozilla/5.0 (Linux; Android 16; Pixel 9 Pro Build/BP2A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/140.0.0.0 Mobile Safari/537.36'
      const sent = (page) => page.evaluate(() => globalThis.__orcaLiveInputProbe.sent())

      /** One composition step through the browser's own IME path, which fires the DOM composition events. */
      async function compose(input, text) {
        await input.send('Input.imeSetComposition', {
          text,
          selectionStart: text.length,
          selectionEnd: text.length
        })
      }

      async function waitForField(page, value) {
        await page.waitForFunction(
          ([id, expected]) => document.getElementById(id)?.value === expected,
          [LIVE_INPUT_FIELD_ID, value],
          { timeout: 30_000, polling: 50 }
        )
      }

      it('sends each letter of a composed word after a slash as it is typed', async () => {
        // The reported shape: `/tui` in a Codex terminal, where the `/` arrived and `tui` did not
        // until Enter. The keyboard commits `/` outright and opens a composition for the letters.
        const { errors, page } = await openProbe({ userAgent: ANDROID_WEBVIEW_USER_AGENT })
        await page.focus(`#${LIVE_INPUT_FIELD_ID}`)
        const input = await page.context().newCDPSession(page)
        await page.keyboard.type('/')
        await waitForField(page, '/')

        const afterEachStep = []
        for (const text of ['t', 'tu', 'tui']) {
          await compose(input, text)
          await waitForField(page, `/${text}`)
          afterEachStep.push(await sent(page))
        }
        await input.send('Input.insertText', { text: 'tui' })
        await waitForField(page, '/tui')

        expect(afterEachStep).toEqual([
          ['/', 't'],
          ['/', 't', 'u'],
          ['/', 't', 'u', 'i']
        ])
        expect(await sent(page)).toEqual(['/', 't', 'u', 'i'])
        expect(errors).toEqual([])
        await page.close()
      }, 300_000)

      it('erases and retypes a word the keyboard corrects when it commits', async () => {
        const { errors, page } = await openProbe({ userAgent: ANDROID_WEBVIEW_USER_AGENT })
        await page.focus(`#${LIVE_INPUT_FIELD_ID}`)
        const input = await page.context().newCDPSession(page)
        for (const text of ['t', 'te', 'teh']) {
          await compose(input, text)
          await waitForField(page, text)
        }

        await input.send('Input.insertText', { text: 'the' })
        await waitForField(page, 'the')

        await page.waitForFunction(
          () => globalThis.__orcaLiveInputProbe.sent().length === 4,
          undefined,
          {
            timeout: 30_000,
            polling: 50
          }
        )
        expect(await sent(page)).toEqual(['t', 'e', 'h', '\u007f\u007fhe'])
        expect(errors).toEqual([])
        await page.close()
      }, 300_000)

      it("still holds a composition off Android, where it is the text system's marked text", async () => {
        // The guard: an iOS WebView composes only what native iOS marks, pinyin before conversion
        // among it, and that is not text yet on either side of the bridge.
        const { errors, page } = await openProbe({
          userAgent:
            'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'
        })
        await page.focus(`#${LIVE_INPUT_FIELD_ID}`)
        const input = await page.context().newCDPSession(page)
        for (const text of ['n', 'ni']) {
          await compose(input, text)
          await waitForField(page, text)
        }

        expect(await sent(page)).toEqual([])
        expect(errors).toEqual([])
        await page.close()
      }, 300_000)
    })

    describe('in buffered mode, where the field holds the draft until Enter', () => {
      const bufferedValue = (page) =>
        page.evaluate((id) => document.getElementById(id)?.value ?? null, BUFFERED_FIELD_ID)

      it('sends the draft and empties the field on a plain Enter', async () => {
        // The guard, not a repro: the clear belongs to `beginBufferedTerminalDraftSend`, which
        // writes '' for the handle at the start of the send. What a browser adds is that the field
        // is a controlled `<input>` here, so this says the draft left the screen and not just the
        // store.
        const { errors, page } = await openProbe()
        await page.focus(`#${BUFFERED_FIELD_ID}`)
        await page.keyboard.type('ls -la')

        await page.keyboard.press('Enter')

        await page.waitForFunction(
          (id) => document.getElementById(id)?.value === '',
          BUFFERED_FIELD_ID,
          { timeout: 30_000, polling: 100 }
        )
        expect(await page.evaluate(() => globalThis.__orcaLiveInputProbe.bufferedSent())).toEqual([
          'ls -la'
        ])
        expect(errors).toEqual([])
        await page.close()
      }, 300_000)

      it('sends the draft when Enter arrives with the keyboard composition still open', async () => {
        // The same react-native-web gate the live field had: this field also reaches its send
        // through `onSubmitEditing` alone, so a soft keyboard's open composition swallows Enter and
        // the draft neither goes out nor leaves the field.
        const { errors, page } = await openProbe()
        await page.focus(`#${BUFFERED_FIELD_ID}`)
        const input = await page.context().newCDPSession(page)
        await input.send('Input.imeSetComposition', {
          text: 'ls -la',
          selectionStart: 6,
          selectionEnd: 6
        })
        await page.waitForFunction(
          (id) => document.getElementById(id)?.value === 'ls -la',
          BUFFERED_FIELD_ID,
          { timeout: 30_000, polling: 100 }
        )

        await page.keyboard.press('Enter')

        await page.waitForFunction(
          () => (globalThis.__orcaLiveInputProbe.bufferedSent() ?? []).length > 0,
          undefined,
          { timeout: 30_000, polling: 100 }
        )
        expect(await page.evaluate(() => globalThis.__orcaLiveInputProbe.bufferedSent())).toEqual([
          'ls -la'
        ])
        expect(await bufferedValue(page)).toBe('')
        expect(errors).toEqual([])
        await page.close()
      }, 300_000)

      it("leaves the draft alone when the key bar's Enter chip fires", async () => {
        // Buffered mode turns the live handle set empty, so the accessory hook declines at its own
        // guard and the chip is a plain terminal key: one carriage return on the wire, and a draft
        // the chip never claimed to send.
        const { errors, page } = await openProbe()
        await page.evaluate(() => globalThis.__orcaLiveInputProbe.setLiveInputEnabled(false))
        await page.focus(`#${BUFFERED_FIELD_ID}`)
        await page.keyboard.type('ls -la')

        const result = await page.evaluate(() =>
          globalThis.__orcaLiveInputProbe.accessory({ bytes: '\r' })
        )

        expect(result).toEqual({ kind: 'allow-raw' })
        expect(await page.evaluate(() => globalThis.__orcaLiveInputProbe.sent())).toEqual(['\r'])
        expect(await page.evaluate(() => globalThis.__orcaLiveInputProbe.bufferedSent())).toEqual(
          []
        )
        expect(await bufferedValue(page)).toBe('ls -la')
        expect(errors).toEqual([])
        await page.close()
      }, 300_000)
    })
  },
  900_000
)

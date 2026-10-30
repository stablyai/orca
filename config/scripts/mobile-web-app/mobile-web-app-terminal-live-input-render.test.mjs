import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium } from 'playwright-core'
import { buildMobileWebAppBundle } from '../build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import {
  BUFFERED_FIELD_ID,
  LIVE_INPUT_FIELD_ID,
  liveInputProbeRouteSource
} from './preview/mobile-web-app-live-input-probe-route.mjs'
import { MOBILE_WEB_APP_ROUTE_ROOT } from './mobile-web-app-route-manifest.mjs'
import {
  createBundleServer,
  installShellDouble,
  readBridgeFaultGrant,
  readBridgeProtocolVersion,
  readShellCsp
} from './preview/mobile-web-app-render-harness.mjs'
import { LAYOUT_SOURCE } from './preview/mobile-web-app-terminal-probe-route.mjs'

// Mount real live-input field: RN-Web refs are DOM nodes without setNativeProps, which once threw in effect and tore down session page.
// No-RPC session-render leaves activeHandle null/live input disabled, so optional ref chain skips defect; source censuses mount nothing.
// Use shipped bundler/web resolution/CSP and PageFaultBoundary to exercise actual hook writes.

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
  const projectDir = fileURLToPath(new URL('../../..', import.meta.url))
  const terminalDir = join(projectDir, 'mobile', 'src', 'terminal')
  const cspHeader = await readShellCsp()
  bridgeVersion = await readBridgeProtocolVersion()
  faultGrant = await readBridgeFaultGrant()
  scratch = await mkdtemp(join(tmpdir(), 'orca-mobile-web-live-input-'))
  const appDir = join(scratch, 'app')
  const routeDir = join(appDir, MOBILE_WEB_APP_ROUTE_ROOT)
  await mkdir(routeDir, { recursive: true })
  await writeFile(join(routeDir, '_layout.tsx'), LAYOUT_SOURCE)
  // Extensionless import selects web sibling as shipped route would.
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

// Wait for probe registration or reported fault; success-only wait hides useful failure behind 60s timeout.
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
      // Catch original page-only TypeError from calling setNativeProps on DOM ref before shell tears view down.
      const { errors, faults, page } = await openProbe()
      expect(faults).toEqual([])
      expect(errors).toEqual([])
      expect(await fieldValue(page)).toBe('')
      await page.close()
    }, 300_000)

    it('writes the field itself, so a drifted value is cleared without a render', async () => {
      const { errors, page } = await openProbe()
      // Seed DOM text unknown to React value prop, like mid-composition IME; clearing unchanged empty capture state cannot rerender it away.
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
      // Use real keydown to exercise RN-Web Enter/onSubmitEditing; command must clear previously sent live text.
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
      // Require exact output once: RN-Web cancels submitted keydown, so page line-break binding must not send second CR.
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
      // Android soft-keyboard Enter carries isComposing; RN-Web suppresses onSubmitEditing unlike native editor action.
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

      // Commit held composition before CR, matching native keystroke order.
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
      // Accessory chip emits no DOM key event; hook itself must finish edit or next keys append to sent text.
      const { errors, page } = await openProbe()
      await page.focus(`#${LIVE_INPUT_FIELD_ID}`)
      await page.keyboard.type('ls')
      await page.waitForFunction(
        (id) => document.getElementById(id)?.value === 'ls',
        LIVE_INPUT_FIELD_ID,
        { timeout: 30_000, polling: 100 }
      )

      await page.evaluate(() => globalThis.__orcaLiveInputProbe.accessory({ bytes: '\r' }))

      // Exactly one branch sends control: hook sends or defers to caller, never both.
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
      // Accessory Backspace writes shortened DOM field before mirror sends PTY erase; broken native-prop write prevented both on page.
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
      // Require one DEL on wire so local field edit cannot silently diverge from PTY.
      expect(await page.evaluate(() => globalThis.__orcaLiveInputProbe.sent())).toEqual([
        'ab',
        '\u007f'
      ])
      expect(errors).toEqual([])
      await page.close()
    }, 300_000)

    it('preserves the middle caret after accessory Delete and subsequent typing', async () => {
      const { errors, page } = await openProbe()
      await page.focus(`#${LIVE_INPUT_FIELD_ID}`)
      await page.keyboard.type('abcdef')
      const sentBeforeSelection = await page.evaluate(() => globalThis.__orcaLiveInputProbe.sent())
      await page.evaluate((id) => {
        document.getElementById(id).setSelectionRange(3, 3)
      }, LIVE_INPUT_FIELD_ID)
      expect(await page.evaluate(() => globalThis.__orcaLiveInputProbe.sent())).toEqual(
        sentBeforeSelection
      )
      expect(
        await page.evaluate(() =>
          globalThis.__orcaLiveInputProbe.accessory({ bytes: '\x1b[3~', localEdit: 'delete' })
        )
      ).toEqual({ kind: 'handled' })
      expect(await fieldValue(page)).toBe('abcef')
      await page.keyboard.type('X')
      expect(await fieldValue(page)).toBe('abcXef')
      expect(errors).toEqual([])
      await page.close()
    }, 300_000)

    describe('under an Android keyboard, which composes every word it types', () => {
      // Android WebView Latin keyboard keeps composing region mid-word; native Android reports no range and forwards ASCII immediately.
      const ANDROID_WEBVIEW_USER_AGENT =
        'Mozilla/5.0 (Linux; Android 16; Pixel 9 Pro Build/BP2A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/140.0.0.0 Mobile Safari/537.36'
      const sent = (page) => page.evaluate(() => globalThis.__orcaLiveInputProbe.sent())

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
        // Reproduce /tui: slash commits, keyboard composes letters which once waited until Enter to reach terminal.
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
        // iOS guard: pinyin composition before conversion is not committed text on either side.
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
        // Controlled DOM field must clear as buffered send begins, not just backing store.
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
        // Buffered field shares RN-Web composing-Enter suppression; require draft sends and clears via web binding.
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
        // Buffered mode leaves live handles empty: accessory declines and chip sends one terminal CR without claiming buffered draft.
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

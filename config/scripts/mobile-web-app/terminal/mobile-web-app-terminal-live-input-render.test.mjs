import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium } from 'playwright-core'
import { buildMobileWebAppBundle } from '../../build/mobile-web-app/build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from '../mobile-web-app-bundle-dependencies.mjs'
import {
  LIVE_INPUT_FIELD_ID,
  liveInputProbeRouteSource
} from '../preview/mobile-web-app-live-input-probe-route.mjs'
import { MOBILE_WEB_APP_ROUTE_ROOT } from '../mobile-web-app-route-manifest.mjs'
import {
  createBundleServer,
  installShellDouble,
  readBridgeFaultGrant,
  readBridgeProtocolVersion,
  readShellCsp
} from '../preview/mobile-web-app-render-harness.mjs'
import { LAYOUT_SOURCE } from '../preview/mobile-web-app-terminal-probe-route.mjs'

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
  const projectDir = fileURLToPath(new URL('../../../..', import.meta.url))
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
      bindingModule: join(terminalDir, 'live-input', 'use-terminal-text-field-submit-binding'),
      commitModule: join(terminalDir, 'live-input', 'use-terminal-live-input-commit')
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

describeRender(
  'the terminal live input on the page',
  () => {
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

    it('sends converted text when the keyboard commits it, without waiting for another key', async () => {
      // WebKit's last input event during a commit still reports isComposing, and none follows compositionend.
      const { errors, page } = await openProbe()
      await page.focus(`#${LIVE_INPUT_FIELD_ID}`)
      const input = await page.context().newCDPSession(page)
      await input.send('Input.imeSetComposition', {
        text: 'にほんご',
        selectionStart: 4,
        selectionEnd: 4
      })
      await page.waitForFunction(
        (id) => document.getElementById(id)?.value === 'にほんご',
        LIVE_INPUT_FIELD_ID,
        { timeout: 30_000, polling: 50 }
      )
      expect(await page.evaluate(() => globalThis.__orcaLiveInputProbe.sent())).toEqual([])

      await input.send('Input.insertText', { text: '日本語' })

      await page.waitForFunction(
        () => globalThis.__orcaLiveInputProbe.sent().length > 0,
        undefined,
        { timeout: 30_000, polling: 50 }
      )
      expect(await page.evaluate(() => globalThis.__orcaLiveInputProbe.sent())).toEqual(['日本語'])
      expect(await fieldValue(page)).toBe('日本語')
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
    })
  },
  900_000
)

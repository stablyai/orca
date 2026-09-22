import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium } from 'playwright-core'
import { buildMobileWebAppBundle } from './build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import {
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
      accessoryModule: join(terminalDir, 'use-terminal-live-accessory-input-commit'),
      flushModule: join(terminalDir, 'use-terminal-live-pending-input-flush')
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
async function openProbe() {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
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
  },
  900_000
)

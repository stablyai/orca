import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium } from 'playwright-core'
import { buildMobileWebAppBundle } from './build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import { MOBILE_WEB_APP_ROUTE_ROOT } from './mobile-web-app-route-manifest.mjs'
import {
  createBundleServer,
  installShellDouble,
  projectDir,
  readBridgeFaultGrant,
  readBridgeProtocolVersion,
  readShellCsp
} from './mobile-web-app-render-harness.mjs'
import { LAYOUT_SOURCE } from './mobile-web-app-terminal-probe-route.mjs'

/**
 * The working rings keep turning on the page. Each is a one-second rotation loop; a loop that
 * stops after its first turn reads `rotate(360deg)` from then on.
 */

const ROUTE = `/${MOBILE_WEB_APP_ROUTE_ROOT}/working-spinner-probe`
const SAMPLE_SECONDS = [1.3, 1.8, 2.4]
const bundles = mobileWebAppDependenciesPresent()
const describeRender = bundles ? describe : describe.skip

function probeRouteSource({ spinnerModule, dotModule }) {
  return `import { View } from 'react-native'
import { AgentSpinner } from ${JSON.stringify(spinnerModule)}
import { AgentStateDot } from ${JSON.stringify(dotModule)}

export default function WorkingSpinnerProbeRoute() {
  globalThis.__orcaWorkingSpinnerProbe = true
  return (
    <View style={{ padding: 24, gap: 24 }}>
      <View nativeID="working-spinner"><AgentSpinner status="working" /></View>
      <View nativeID="working-dot"><AgentStateDot state="working" /></View>
    </View>
  )
}
`
}

let browser = null
let origin = null
let scratch = null
let server = null

beforeAll(async () => {
  if (!bundles) {
    return
  }
  const componentsDir = join(projectDir, 'mobile', 'src', 'components')
  const cspHeader = await readShellCsp()
  scratch = await mkdtemp(join(tmpdir(), 'orca-mobile-web-working-spinner-'))
  const appDir = join(scratch, 'app')
  const routeDir = join(appDir, MOBILE_WEB_APP_ROUTE_ROOT)
  await mkdir(routeDir, { recursive: true })
  await writeFile(join(routeDir, '_layout.tsx'), LAYOUT_SOURCE)
  await writeFile(
    join(routeDir, 'working-spinner-probe.tsx'),
    probeRouteSource({
      spinnerModule: join(componentsDir, 'AgentSpinner'),
      dotModule: join(componentsDir, 'AgentStateDot')
    })
  )
  const built = await buildMobileWebAppBundle({
    appDir,
    outDir: join(scratch, 'bundle'),
    pageRoutes: [{ pathname: ROUTE, grants: [] }]
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

async function openProbe() {
  const faultGrant = await readBridgeFaultGrant()
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  await page.addInitScript(installShellDouble, {
    version: await readBridgeProtocolVersion(),
    sessionId: 'working-spinner-session',
    buildId: 'working-spinner-build',
    route: { pathname: ROUTE, params: {} },
    host: { id: 'spinner-host', name: 'Spinner Host', endpoint: 'ws://spinner', lastConnected: 1 },
    storage: {},
    faultGrant,
    grants: [faultGrant],
    pageRoutes: [ROUTE],
    replies: {}
  })
  const errors = []
  page.on('pageerror', (error) => errors.push(`${error.name}: ${error.message}`))
  await page.goto(`${origin}/`, { waitUntil: 'load' })
  await page.waitForFunction(
    () =>
      globalThis.__orcaWorkingSpinnerProbe !== undefined ||
      (globalThis.__orcaRenderCheckFaults ?? []).length > 0,
    { timeout: 60_000, polling: 100 }
  )
  expect(await page.evaluate(() => globalThis.__orcaRenderCheckFaults ?? [])).toEqual([])
  return { errors, page }
}

/** The rotating ring is the only element under each wrapper that carries an inline transform. */
const readRotations = (page) =>
  page.evaluate(() =>
    ['working-spinner', 'working-dot'].map(
      (id) =>
        [...document.querySelectorAll(`#${id} *`)].find((node) => node.style.transform)?.style
          .transform ?? null
    )
  )

describeRender('working rings on the page', () => {
  it('keeps both rings turning past the first second', async () => {
    const { errors, page } = await openProbe()
    const started = Date.now()
    const samples = []
    for (const seconds of SAMPLE_SECONDS) {
      await page.waitForTimeout(Math.max(0, started + seconds * 1000 - Date.now()))
      samples.push(await readRotations(page))
    }
    for (const ring of [0, 1]) {
      const angles = samples.map((sample) => sample[ring])
      expect(new Set(angles).size, `ring ${ring} after 1.3 s: ${angles.join(', ')}`).toBe(
        angles.length
      )
    }
    expect(errors).toEqual([])
    await page.close()
  }, 300_000)
})

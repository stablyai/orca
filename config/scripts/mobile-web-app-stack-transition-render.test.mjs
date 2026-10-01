import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium } from 'playwright-core'
import { buildMobileWebAppBundle } from './build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import { MOBILE_WEB_APP_ROUTE_ROOT } from './mobile-web-app-route-manifest.mjs'
import {
  createBundleServer,
  installShellDouble,
  readBridgeFaultGrant,
  readBridgeProtocolVersion,
  readShellCsp
} from './mobile-web-app-render-harness.mjs'

/**
 * The host stack's push and pop on the page, sampled every animation frame in a real browser.
 *
 * The native stack slides; the page's stack is `HostStack`'s web half, and before it existed the
 * page rendered native-stack's web view, which flips `display` and nothing else. The probe tree
 * mounts the real `HostStack` (extensionless, so its `.web.tsx` wins as it does on a real route)
 * over two marked screens, so the frames measure the stack and not what a screen paints.
 */

const HOST_ID = 'stack-host'
const LIST_ROUTE = `/${MOBILE_WEB_APP_ROUTE_ROOT}/${HOST_ID}`
const SESSION_HREF = `${LIST_ROUTE}/session/wt-1`
const VIEWPORT = { width: 390, height: 844 }
const SAMPLE_MS = 1500

const bundles = mobileWebAppDependenciesPresent()
const describeRender = bundles ? describe : describe.skip

let browser = null
let origin = null
let scratch = null
let server = null
let bridgeVersion = null
let faultGrant = null

const layoutSource = (
  hostStackModule
) => `import { HostStack } from ${JSON.stringify(hostStackModule)}
export default function ProbeHostLayout() {
  return <HostStack animation={globalThis.__orcaStackProbeAnimation ?? 'default'} />
}
`

const LIST_SOURCE = `import { useEffect } from 'react'
import { View } from 'react-native'
import { useRouter } from 'expo-router'
export default function ProbeList() {
  const router = useRouter()
  useEffect(() => {
    globalThis.__orcaStackProbe = {
      push: () => router.push(${JSON.stringify(SESSION_HREF)}),
      back: () => router.back()
    }
  }, [router])
  return <View testID="stack-probe-list" style={{ flex: 1, backgroundColor: '#204060' }} />
}
`

const SESSION_SOURCE = `import { View } from 'react-native'
export default function ProbeSession() {
  return <View testID="stack-probe-session" style={{ flex: 1, backgroundColor: '#602040' }} />
}
`

beforeAll(async () => {
  if (!bundles) {
    return
  }
  const projectDir = fileURLToPath(new URL('../..', import.meta.url))
  const cspHeader = await readShellCsp()
  bridgeVersion = await readBridgeProtocolVersion()
  faultGrant = await readBridgeFaultGrant()
  scratch = await mkdtemp(join(tmpdir(), 'orca-mobile-web-stack-transition-'))
  const routeDir = join(scratch, 'app', MOBILE_WEB_APP_ROUTE_ROOT)
  await mkdir(join(routeDir, '[hostId]', 'session'), { recursive: true })
  await writeFile(
    join(routeDir, '_layout.tsx'),
    layoutSource(join(projectDir, 'mobile', 'src', 'navigation', 'host-stack'))
  )
  await writeFile(join(routeDir, '[hostId]', 'index.tsx'), LIST_SOURCE)
  await writeFile(join(routeDir, '[hostId]', 'session', '[worktreeId].tsx'), SESSION_SOURCE)
  const built = await buildMobileWebAppBundle({
    appDir: join(scratch, 'app'),
    outDir: join(scratch, 'bundle'),
    pageRoutes: [
      { pathname: `/${MOBILE_WEB_APP_ROUTE_ROOT}/[hostId]`, grants: [] },
      { pathname: `/${MOBILE_WEB_APP_ROUTE_ROOT}/[hostId]/session/[worktreeId]`, grants: [] }
    ]
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

async function openList({ animation = 'default', reducedMotion = 'no-preference' } = {}) {
  const page = await browser.newPage({ viewport: VIEWPORT, reducedMotion })
  await page.addInitScript((value) => {
    globalThis.__orcaStackProbeAnimation = value
  }, animation)
  await page.addInitScript(installShellDouble, {
    version: bridgeVersion,
    sessionId: 'stack-transition-session',
    buildId: 'stack-transition-build',
    route: { pathname: LIST_ROUTE, params: {} },
    host: { id: HOST_ID, name: 'Stack Host', endpoint: 'ws://stack', lastConnected: 1 },
    storage: {},
    faultGrant,
    grants: [faultGrant],
    pageRoutes: [LIST_ROUTE, SESSION_HREF],
    replies: {}
  })
  const errors = []
  page.on('pageerror', (error) => errors.push(`${error.name}: ${error.message}`))
  await page.goto(`${origin}/`, { waitUntil: 'load' })
  await page.waitForFunction(() => globalThis.__orcaStackProbe !== undefined, null, {
    timeout: 60_000,
    polling: 100
  })
  return { errors, page }
}

/**
 * Runs `action` on the probe, then reads both screens' left edge once per animation frame.
 * A hidden screen (display: none, or unmounted) reads as null.
 */
function sampleFrames(page, action) {
  return page.evaluate(
    ([name, sampleMs]) =>
      new Promise((resolve) => {
        const leftOf = (id) => {
          const node = document.querySelector(`[data-testid="${id}"]`)
          const rect = node?.getBoundingClientRect()
          return rect && rect.width > 0 ? Math.round(rect.left) : null
        }
        const frames = []
        const start = performance.now()
        globalThis.__orcaStackProbe[name]()
        const tick = () => {
          frames.push({ list: leftOf('stack-probe-list'), session: leftOf('stack-probe-session') })
          if (performance.now() - start < sampleMs) {
            requestAnimationFrame(tick)
          } else {
            resolve(frames)
          }
        }
        requestAnimationFrame(tick)
      }),
    [action, SAMPLE_MS]
  )
}

const between = (left) => left !== null && left > 0 && left < VIEWPORT.width

describeRender('the host stack transition on the page', () => {
  it('slides the session in from the right on push, over the list', async () => {
    const { errors, page } = await openList()
    const frames = await sampleFrames(page, 'push')
    const firstShown = frames.find((frame) => frame.session !== null)
    // Red on native-stack's web view: the session's first visible frame is already at x = 0.
    expect(firstShown?.session).toBeGreaterThan(0)
    expect(frames.some((frame) => between(frame.session) && frame.list === 0)).toBe(true)
    expect(frames.at(-1)).toEqual({ list: null, session: 0 })
    expect(errors).toEqual([])
    await page.close()
  }, 120_000)

  it('slides the session out to the right on Back, revealing the list', async () => {
    const { errors, page } = await openList()
    await sampleFrames(page, 'push')
    const frames = await sampleFrames(page, 'back')
    // Red on native-stack's web view: the popped screen is gone on the first frame after Back.
    expect(frames.some((frame) => between(frame.session) && frame.list === 0)).toBe(true)
    expect(frames.at(-1)).toEqual({ list: 0, session: null })
    expect(errors).toEqual([])
    await page.close()
  }, 120_000)

  it('swaps instantly in the tablet split view and under reduced motion', async () => {
    for (const options of [{ animation: 'none' }, { reducedMotion: 'reduce' }]) {
      const { errors, page } = await openList(options)
      const pushed = await sampleFrames(page, 'push')
      expect(pushed.filter((frame) => between(frame.session))).toEqual([])
      expect(pushed.at(-1)).toEqual({ list: null, session: 0 })
      const popped = await sampleFrames(page, 'back')
      expect(popped.filter((frame) => between(frame.session))).toEqual([])
      expect(popped.at(-1)).toEqual({ list: 0, session: null })
      expect(errors).toEqual([])
      await page.close()
    }
  }, 120_000)
})

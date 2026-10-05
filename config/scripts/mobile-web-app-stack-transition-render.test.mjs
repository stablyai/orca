import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, webkit } from 'playwright-core'
import { buildMobileWebAppBundle } from './build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import { MOBILE_WEB_APP_ROUTE_ROOT } from './mobile-web-app-route-manifest.mjs'
import {
  createBundleServer,
  installShellDouble,
  readBridgeBackNames,
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

/** WKWebView carries the page on iOS, so WebKit's Web Animations and keyframes count too. */
const ENGINES = [
  {
    name: 'chromium',
    launch: () => {
      const executablePath = process.env.ORCA_MOBILE_WEB_RENDER_BROWSER
      return chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
    }
  },
  { name: 'webkit', launch: () => webkit.launch({ headless: true }) }
]

const browsers = new Map()
let origin = null
let scratch = null
let server = null
let bridgeVersion = null
let faultGrant = null
let backNames = null

const layoutSource = (
  hostStackModule
) => `import { HostStack } from ${JSON.stringify(hostStackModule)}
export default function ProbeHostLayout() {
  return <HostStack animation={globalThis.__orcaStackProbeAnimation ?? 'default'} />
}
`

// Both screens go through the page's real router seam, so Back claims and pops as shipped.
const listSource = (handoffModule) => `import { useEffect } from 'react'
import { View } from 'react-native'
import { useRouteHandoff } from ${JSON.stringify(handoffModule)}
export default function ProbeList() {
  const router = useRouteHandoff()
  useEffect(() => {
    globalThis.__orcaStackProbe = {
      push: () => router.push(${JSON.stringify(SESSION_HREF)}),
      pushOther: () => router.push(${JSON.stringify(`${LIST_ROUTE}/session/wt-2`)}),
      back: () => router.back(),
      hardwareBack: () => globalThis.__orcaRenderCheckSendBack()
    }
  }, [router])
  return <View testID="stack-probe-list" style={{ flex: 1, backgroundColor: '#204060' }} />
}
`

// Counts mounts, so a screen remounted for its exit slide reads as a second one.
const sessionSource = (handoffModule) => `import { useEffect } from 'react'
import { View } from 'react-native'
import { useRouteHandoff } from ${JSON.stringify(handoffModule)}
export default function ProbeSession() {
  useRouteHandoff()
  useEffect(() => {
    globalThis.__orcaSessionMounts = (globalThis.__orcaSessionMounts ?? 0) + 1
  }, [])
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
  const navigationDir = join(projectDir, 'mobile', 'src', 'navigation')
  const handoffModule = join(navigationDir, 'route-handoff')
  backNames = await readBridgeBackNames()
  await writeFile(join(routeDir, '_layout.tsx'), layoutSource(join(navigationDir, 'host-stack')))
  await writeFile(join(routeDir, '[hostId]', 'index.tsx'), listSource(handoffModule))
  await writeFile(
    join(routeDir, '[hostId]', 'session', '[worktreeId].tsx'),
    sessionSource(handoffModule)
  )
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
  for (const engine of ENGINES) {
    browsers.set(engine.name, await engine.launch())
  }
}, 600_000)

afterAll(async () => {
  for (const browser of browsers.values()) {
    await browser.close()
  }
  server?.close()
  if (scratch) {
    await rm(scratch, { recursive: true, force: true })
  }
})

async function openList(browser, { animation = 'default', reducedMotion = 'no-preference' } = {}) {
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
    backFrame: backNames.frame,
    pageRoutes: [
      `/${MOBILE_WEB_APP_ROUTE_ROOT}/[hostId]`,
      `/${MOBILE_WEB_APP_ROUTE_ROOT}/[hostId]/session/[worktreeId]`
    ],
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
 * Runs `action` on the probe, then reads both screens' left edge once per animation frame, and
 * which screen a tap at the centre would land on. A hidden screen, or no screen hit, reads as null.
 */
function sampleFrames(page, action, { followUp = null, afterFrames = 0 } = {}) {
  return page.evaluate(
    ([name, sampleMs, nextAction, followAt]) =>
      new Promise((resolve) => {
        const leftOf = (id) => {
          const node = document.querySelector(`[data-testid="${id}"]`)
          const rect = node?.getBoundingClientRect()
          return rect && rect.width > 0 ? Math.round(rect.left) : null
        }
        const hitAt = () =>
          document
            .elementFromPoint(innerWidth / 2, innerHeight / 2)
            ?.closest('[data-testid^="stack-probe-"]')
            ?.getAttribute('data-testid')
            ?.replace('stack-probe-', '') ?? null
        const frames = []
        const start = performance.now()
        globalThis.__orcaStackProbe[name]()
        const tick = () => {
          if (nextAction !== null && frames.length === followAt) {
            globalThis.__orcaStackProbe[nextAction]()
          }
          frames.push({
            list: leftOf('stack-probe-list'),
            session: leftOf('stack-probe-session'),
            hit: hitAt(),
            // Where the running slide starts, which is how a slide that restarts from 0 shows.
            from: document.getAnimations()[0]?.effect?.getKeyframes()[0]?.transform ?? null
          })
          if (performance.now() - start < sampleMs) {
            requestAnimationFrame(tick)
          } else {
            resolve(frames)
          }
        }
        requestAnimationFrame(tick)
      }),
    [action, SAMPLE_MS, followUp, afterFrames]
  )
}

/** Every element in the document, hidden ones included: a retained slot still counts. */
const nodeCount = (page) => page.evaluate(() => document.querySelectorAll('*').length)

async function waitForBackClaim(page) {
  await page.waitForFunction(
    (name) =>
      globalThis.__orcaRenderCheckNotifies.some(
        (frame) => frame.name === name && frame.claimed === true
      ),
    backNames.claim,
    { timeout: 10_000, polling: 50 }
  )
}

const between = (left) => left !== null && left > 0 && left < VIEWPORT.width
const sliding = (frames) => frames.filter((frame) => between(frame.session))
const SESSION_SETTLED = { list: null, session: 0, hit: 'session', from: null }
const LIST_SETTLED = { list: 0, session: null, hit: 'list', from: null }
const sessionMounts = (page) => page.evaluate(() => globalThis.__orcaSessionMounts ?? 0)

describeRender('the host stack transition on the page', () => {
  for (const engine of ENGINES) {
    describe(engine.name, () => {
      const open = (options) => openList(browsers.get(engine.name), options)
      it('slides the session in from the right on push, over the list', async () => {
        const { errors, page } = await open()
        const frames = await sampleFrames(page, 'push')
        const firstShown = frames.find((frame) => frame.session !== null)
        // Red on native-stack's web view: the session's first visible frame is already at x = 0.
        expect(firstShown?.session).toBeGreaterThan(0)
        expect(frames.some((frame) => between(frame.session) && frame.list === 0)).toBe(true)
        // The list stays painted under the slide but takes no tap, so a double tap cannot push twice.
        expect(sliding(frames).map((frame) => frame.hit)).toEqual(sliding(frames).map(() => null))
        expect(frames.at(-1)).toEqual(SESSION_SETTLED)
        expect(errors).toEqual([])
        await page.close()
      }, 120_000)

      it('slides the session out to the right on Back, revealing the list', async () => {
        const { errors, page } = await open()
        await sampleFrames(page, 'push')
        expect(await sessionMounts(page)).toBe(1)
        const frames = await sampleFrames(page, 'back')
        // Red on native-stack's web view: the popped screen is gone on the first frame after Back.
        expect(frames.some((frame) => between(frame.session) && frame.list === 0)).toBe(true)
        // The screen sliding out is the one that was on screen, not a fresh mount of it.
        expect(await sessionMounts(page)).toBe(1)
        expect(frames.at(-1)).toEqual(LIST_SETTLED)
        expect(errors).toEqual([])
        await page.close()
      }, 120_000)

      it('pops with the slide on the device Back key and drops the popped screen', async () => {
        const { errors, page } = await open()
        const baseline = await nodeCount(page)
        await sampleFrames(page, 'push')
        await waitForBackClaim(page)
        const frames = await sampleFrames(page, 'hardwareBack')
        expect(frames.some((frame) => between(frame.session) && frame.list === 0)).toBe(true)
        expect(frames.at(-1)).toEqual(LIST_SETTLED)
        expect(await nodeCount(page)).toBe(baseline)
        expect(errors).toEqual([])
        await page.close()
      }, 120_000)

      it('leaves no slot behind when a push interrupts a pop', async () => {
        const { errors, page } = await open()
        await sampleFrames(page, 'push')
        const pushed = await nodeCount(page)
        const frames = await sampleFrames(page, 'back', { followUp: 'push', afterFrames: 3 })
        expect(frames.slice(0, 3).some((frame) => between(frame.session))).toBe(true)
        expect(frames.at(-1)).toEqual(SESSION_SETTLED)
        expect(await nodeCount(page)).toBe(pushed)
        expect(
          await page.evaluate(
            () => document.querySelectorAll('[data-testid="stack-probe-session"]').length
          )
        ).toBe(1)
        expect(errors).toEqual([])
        await page.close()
      }, 120_000)

      it('settles on the list when Back interrupts an unfinished push', async () => {
        const { errors, page } = await open()
        // Warm the session chunk, so the interrupted push is mid-slide rather than waiting for content.
        await sampleFrames(page, 'push')
        await sampleFrames(page, 'back')
        const baseline = await nodeCount(page)
        const mounts = await sessionMounts(page)
        const frames = await sampleFrames(page, 'push', { followUp: 'back', afterFrames: 6 })
        expect(between(frames[5].session)).toBe(true)
        // Leaves from where the push stopped, not from 0: the exit's first keyframe is mid-screen.
        const exitFrom = frames.slice(6).find((frame) => frame.from?.startsWith('matrix'))?.from
        const startX = Number(exitFrom?.match(/matrix\(1, 0, 0, 1, ([\d.]+), 0\)/)?.[1])
        expect(between(startX)).toBe(true)
        const leaving = frames
          .slice(6)
          .map((frame) => frame.session)
          .filter((left) => left !== null)
        expect(leaving).toEqual(leaving.toSorted((a, b) => a - b))
        expect(frames.at(-1)).toEqual(LIST_SETTLED)
        expect(await nodeCount(page)).toBe(baseline)
        expect(await sessionMounts(page)).toBe(mounts + 1)
        expect(errors).toEqual([])
        await page.close()
      }, 120_000)

      it('slides a screen out from rest after a push that once interrupted its entry', async () => {
        const { errors, page } = await open()
        await sampleFrames(page, 'push')
        await sampleFrames(page, 'back')
        // wt-1 is still entering when wt-2 covers it, so wt-1 settles beneath at rest.
        await sampleFrames(page, 'push', { followUp: 'pushOther', afterFrames: 6 })
        await sampleFrames(page, 'back')
        const frames = await sampleFrames(page, 'back')
        // getKeyframes() reports the keyframe normalized, as translateX(0px).
        expect(frames.find((frame) => frame.from !== null)?.from).toMatch(/^translateX\(0(px)?\)$/)
        expect(frames.at(-1)).toEqual(LIST_SETTLED)
        expect(errors).toEqual([])
        await page.close()
      }, 120_000)

      it('swaps instantly in the tablet split view and under reduced motion', async () => {
        for (const options of [{ animation: 'none' }, { reducedMotion: 'reduce' }]) {
          const { errors, page } = await open(options)
          const pushed = await sampleFrames(page, 'push')
          expect(pushed.filter((frame) => between(frame.session))).toEqual([])
          expect(pushed.at(-1)).toEqual(SESSION_SETTLED)
          const popped = await sampleFrames(page, 'back')
          expect(popped.filter((frame) => between(frame.session))).toEqual([])
          expect(popped.at(-1)).toEqual(LIST_SETTLED)
          expect(errors).toEqual([])
          await page.close()
        }
      }, 120_000)
    })
  }
})

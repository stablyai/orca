import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium } from 'playwright-core'
import { buildMobileWebAppBundle } from '../../build/mobile-web-app/build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from '../mobile-web-app-bundle-dependencies.mjs'
import { MOBILE_WEB_PAGE_ROUTES } from '../../build/mobile-web-app/mobile-web-page-routes.mjs'
import {
  createBundleServer,
  installShellDouble,
  readBridgeBackNames,
  readBridgeFaultGrant,
  readBridgeProtocolVersion,
  readShellCsp
} from '../preview/mobile-web-app-render-harness.mjs'

// The host document opens the shell's `open` target itself (Jump back in, notification taps) instead of the shell pushing a second document.
// Only the real bundle proves the target paints first with the host list beneath it, and that Back pops inside the page.

const HOST_ROUTE = '/h/render-check-host'
const SESSION_ROUTE = `${HOST_ROUTE}/session/wt-1`
const HOST_PATTERN = '/h/[hostId]'
const SESSION_PATTERN = '/h/[hostId]/session/[worktreeId]'
const STATUS_REPLY = {
  protocolVersion: 9,
  minCompatibleMobileVersion: 1,
  appVersion: '1.4.191',
  capabilities: []
}

const bundles = mobileWebAppDependenciesPresent()
const describeRender = bundles ? describe : describe.skip

let scratch
let server
let browser
let origin
let cspHeader = null
let bridgeVersion = null
let faultGrant = null
let backNames = null

function grantsFor(patterns) {
  return [
    ...new Set(
      MOBILE_WEB_PAGE_ROUTES.filter((route) => patterns.includes(route.pathname)).flatMap(
        (route) => route.grants
      )
    )
  ]
}

beforeAll(async () => {
  if (!bundles) {
    return
  }
  cspHeader = await readShellCsp()
  bridgeVersion = await readBridgeProtocolVersion()
  faultGrant = await readBridgeFaultGrant()
  backNames = await readBridgeBackNames()
  scratch = await mkdtemp(join(tmpdir(), 'orca-mobile-web-app-open-target-'))
  const { outDir } = await buildMobileWebAppBundle({ outDir: join(scratch, 'bundle') })
  const served = await createBundleServer({ outDir, cspHeader })
  server = served.server
  origin = served.origin
  const executablePath = process.env.ORCA_MOBILE_WEB_RENDER_BROWSER
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
}, 180_000)

afterAll(async () => {
  await browser?.close()
  server?.close()
  if (scratch) {
    await rm(scratch, { recursive: true, force: true })
  }
})

/** Boots the host document under a shell double, recording what the page sent before its first `painted`. */
async function openHostDocument({
  route,
  pageRoutes = [HOST_PATTERN, SESSION_PATTERN],
  backOnFirstClaim = false
}) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  await page.addInitScript(installShellDouble, {
    version: bridgeVersion,
    sessionId: 'open-target-session',
    buildId: 'open-target-build',
    route,
    host: {
      id: 'render-check-host',
      name: 'Render Check Host',
      endpoint: 'ws://render-check',
      lastConnected: 1
    },
    storage: {},
    faultGrant,
    grants: [faultGrant, ...grantsFor(pageRoutes)],
    pageRoutes,
    backFrame: backNames.frame,
    replies: { 'status.get': STATUS_REPLY }
  })
  if (backOnFirstClaim) {
    // Press Back the moment the page first claims it, before the target's paint releases the stack.
    await page.addInitScript((claim) => {
      const channel = globalThis.orcaBridge
      const post = channel.postMessage
      let pressed = false
      channel.postMessage = (json) => {
        const result = post(json)
        const frame = JSON.parse(json)
        if (!pressed && frame.name === claim && frame.claimed === true) {
          pressed = true
          queueMicrotask(() => globalThis.__orcaRenderCheckSendBack())
        }
        return result
      }
    }, backNames.claim)
  }
  await page.addInitScript(() => {
    globalThis.__openTargetBeforePaint = null
    const channel = globalThis.orcaBridge
    const post = channel.postMessage
    channel.postMessage = (json) => {
      const frame = JSON.parse(json)
      if (frame.name === 'painted' && globalThis.__openTargetBeforePaint === null) {
        globalThis.__openTargetBeforePaint = {
          pathname: location.pathname,
          requests: globalThis.__orcaRenderCheckRequests.map((request) => request.method)
        }
      }
      return post(json)
    }
  })
  const errors = []
  page.on('pageerror', (error) => errors.push(`${error.name}: ${error.message}`))
  await page.goto(`${origin}/`, { waitUntil: 'load' })
  const painted = await page.waitForFunction(() => globalThis.__openTargetBeforePaint, undefined, {
    timeout: 30_000,
    polling: 50
  })
  return { page, errors, beforePaint: await painted.jsonValue() }
}

function notifies(page, name) {
  return page.evaluate(
    (wanted) =>
      (globalThis.__orcaRenderCheckNotifies ?? []).filter((frame) => frame.name === wanted),
    name
  )
}

async function pressBack(page) {
  await page.waitForFunction(
    (claim) =>
      (globalThis.__orcaRenderCheckNotifies ?? []).some(
        (frame) => frame.name === claim && frame.claimed === true
      ),
    backNames.claim,
    { timeout: 10_000, polling: 100 }
  )
  await page.evaluate(() => {
    globalThis.__orcaRenderCheckSendBack()
  })
}

describeRender('a host document asked to open a target', () => {
  it('paints the target first and pops back to the host list in the page', async () => {
    const { page, errors, beforePaint } = await openHostDocument({
      route: { pathname: HOST_ROUTE, params: { open: SESSION_ROUTE } }
    })
    expect(beforePaint.pathname).toBe(SESSION_ROUTE)
    // The host list loads its worktrees when it shows; nothing of it may compete with the target's first paint.
    expect(beforePaint.requests).not.toContain('worktree.ps')
    expect(await notifies(page, 'route-param-clear')).toEqual([
      {
        v: bridgeVersion,
        type: 'notify',
        name: 'route-param-clear',
        param: 'open',
        value: SESSION_ROUTE
      }
    ])
    await pressBack(page)
    await page.waitForFunction((host) => location.pathname === host, HOST_ROUTE, {
      timeout: 10_000,
      polling: 100
    })
    expect(await notifies(page, backNames.navigateBack)).toEqual([])
    expect(errors).toEqual([])
    await page.close()
  }, 60_000)

  it('takes taps again after a Back that lands before the target paints', async () => {
    const { page, errors } = await openHostDocument({
      route: { pathname: HOST_ROUTE, params: { open: SESSION_ROUTE } },
      backOnFirstClaim: true
    })
    await page.waitForFunction((host) => location.pathname === host, HOST_ROUTE, {
      timeout: 10_000,
      polling: 100
    })
    // The pop's slide has to settle, or the stack keeps refusing every tap.
    await page.waitForFunction(
      () => {
        const fab = [...document.querySelectorAll('[role="button"]')].find(
          (element) =>
            element.getAttribute('aria-label') === 'New workspace' &&
            element.getBoundingClientRect().width > 0
        )
        if (fab === undefined) {
          return false
        }
        const box = fab.getBoundingClientRect()
        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
        return hit !== null && fab.contains(hit)
      },
      undefined,
      { timeout: 10_000, polling: 100 }
    )
    expect(errors).toEqual([])
    await page.close()
  }, 60_000)

  it('hands a target this document does not serve back to the shell', async () => {
    // The target would otherwise run with the host page's grants.
    const { page, errors, beforePaint } = await openHostDocument({
      route: { pathname: HOST_ROUTE, params: { open: SESSION_ROUTE } },
      pageRoutes: [HOST_PATTERN]
    })
    expect(beforePaint.pathname).toBe(HOST_ROUTE)
    expect(await notifies(page, 'navigate')).toEqual([
      { v: bridgeVersion, type: 'notify', name: 'navigate', href: SESSION_ROUTE }
    ])
    expect(errors).toEqual([])
    await page.close()
  }, 60_000)
})

describeRender('a session document opened on a pane', () => {
  it('paints without faulting while its first commit erases the pane from the URL', async () => {
    // A notification tap names the pane; the preloaded session mounts before Expo's container reports ready.
    const { page, errors } = await openHostDocument({
      route: { pathname: SESSION_ROUTE, params: { paneKey: 'tab-1:leaf-1' } }
    })
    expect(await notifies(page, 'fault')).toEqual([])
    // Spent, so a remount of the screen cannot replay it over a later tab pick.
    await page.waitForFunction(() => location.search === '', undefined, {
      timeout: 10_000,
      polling: 100
    })
    expect(errors).toEqual([])
    await page.close()
  }, 60_000)
})

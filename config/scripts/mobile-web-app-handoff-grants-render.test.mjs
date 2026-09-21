import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium } from 'playwright-core'
import { buildMobileWebAppBundle } from './build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import {
  createBundleServer,
  installShellDouble,
  readBridgeFaultGrant,
  readBridgeProtocolVersion,
  readShellCsp
} from './mobile-web-app-render-harness.mjs'

/**
 * The in-page hop the sidebar makes, in a browser, under the grants the session actually has.
 *
 * On a wide layout `app/h/_layout.tsx` renders the worktree list beside every `/h` route, and its
 * header pushes `/h/<id>/tasks` through `useRouteHandoff`. Keeping that local runs the tasks page
 * under the opener's grants, so its copy actions refuse with nothing on screen. The unit tests pin
 * the decision; only a browser proves the control exists, is reachable at that viewport, and that
 * the document does not move when the hop is handed over.
 */

const HOST_ROUTE = '/h/render-check-host'
const FILES_ROUTE = '/h/render-check-host/files/wt-1'
const HOST_PATTERN = '/h/[hostId]'
const TASKS_PATTERN = '/h/[hostId]/tasks'
const FILES_PATTERN = '/h/[hostId]/files/[worktreeId]'
const SHELL_SESSION_ID = 'render-check-session'
const SHELL_BUILD_ID = 'render-check-build'
const SHELL_HOST = {
  id: 'render-check-host',
  name: 'Render Check Host',
  endpoint: 'ws://render-check',
  lastConnected: 1
}
/** The manifest's own pairs, as the shell would send them. */
const PAGE_ROUTE_GRANTS = [
  { pathname: HOST_PATTERN, grants: ['navigate', 'storage', 'haptics'] },
  { pathname: FILES_PATTERN, grants: ['navigate', 'storage', 'externalLink', 'haptics'] },
  {
    pathname: TASKS_PATTERN,
    grants: ['navigate', 'storage', 'externalLink', 'haptics', 'native.clipboard.write']
  }
]
/** Wide enough for `app/h/_layout.tsx` to render the sidebar beside the route. */
const WIDE = { width: 1180, height: 820 }
const NARROW = { width: 390, height: 844 }

const bundles = mobileWebAppDependenciesPresent()
const describeRender = bundles ? describe : describe.skip

let scratch
let server
let browser
let origin
let cspHeader = null
let bridgeVersion = null
let faultGrant = null

beforeAll(async () => {
  if (!bundles) {
    return
  }
  cspHeader = await readShellCsp()
  bridgeVersion = await readBridgeProtocolVersion()
  faultGrant = await readBridgeFaultGrant()
  scratch = await mkdtemp(join(tmpdir(), 'orca-mobile-web-app-handoff-'))
  const built = await buildMobileWebAppBundle({ outDir: join(scratch, 'bundle') })
  const served = await createBundleServer({ outDir: built.outDir, cspHeader })
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

/** Opens the worktree list at a viewport, under a named set of session grants. */
async function openHostRoute({
  viewport,
  grants,
  pageRouteGrants = PAGE_ROUTE_GRANTS,
  route = HOST_ROUTE,
  awaitText = SHELL_HOST.name
}) {
  const page = await browser.newPage({ viewport })
  await page.addInitScript(installShellDouble, {
    version: bridgeVersion,
    sessionId: SHELL_SESSION_ID,
    buildId: SHELL_BUILD_ID,
    route: { pathname: route },
    host: SHELL_HOST,
    storage: {},
    faultGrant,
    grants,
    pageRoutes: [HOST_PATTERN, FILES_PATTERN, TASKS_PATTERN],
    pageRouteGrants
  })
  const errors = []
  const scripts = []
  // Every script answer, not only the ones that arrived: a chunk the navigation waits on can fail
  // with a status the 200-only list cannot show.
  const jsResponses = []
  page.on('pageerror', (error) => errors.push(`${error.name}: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(`console.error: ${message.text()}`)
    }
  })
  page.on('response', (response) => {
    const path = new URL(response.url()).pathname
    if (!path.endsWith('.js')) {
      return
    }
    jsResponses.push({ status: response.status(), path })
    if (response.status() === 200) {
      scripts.push(path)
    }
  })
  await page.goto(`${origin}/`, { waitUntil: 'load' })
  await page.waitForFunction(() => document.documentElement.dataset.orcaWebEntry === 'mounted', {
    timeout: 30_000,
    polling: 250
  })
  await page.waitForFunction((needle) => document.body.innerText.includes(needle), awaitText, {
    timeout: 30_000,
    polling: 250
  })
  return { page, errors, scripts, jsResponses }
}

/** Every `navigate` notify the page posted, in order. */
function navigates(page) {
  return page.evaluate(() =>
    (globalThis.__orcaRenderCheckNotifies ?? []).filter((frame) => frame.name === 'navigate')
  )
}

/**
 * The wait for the hop to land, and the page's own account of why it did not.
 *
 * A navigation that never commits reads as a bare 30 s timeout. The CI failure this file first hit
 * was a `TypeError` thrown inside React Navigation that blanked the document, and it was invisible
 * because the error assertions run after a wait that never returns.
 */
async function waitForTasksRoute(page, opened, clickedAt) {
  try {
    await page.waitForFunction(() => location.pathname.endsWith('/tasks'), {
      timeout: 30_000,
      polling: 250
    })
  } catch (cause) {
    const seen = await page.evaluate(() => ({
      pathname: location.pathname,
      text: document.body.innerText.slice(0, 300)
    }))
    throw new Error(
      [
        `the document never reached /tasks; pathname is ${seen.pathname}`,
        `page errors: ${JSON.stringify(opened.errors)}`,
        `navigate notifies: ${JSON.stringify(await navigates(page))}`,
        `body text: ${JSON.stringify(seen.text)}`,
        `js responses since the click: ${JSON.stringify(opened.jsResponses.slice(clickedAt))}`
      ].join('\n'),
      { cause }
    )
  }
}

describeRender('the sidebar hop to tasks, under the session it was opened with', () => {
  it('hands the hop to the shell when the session cannot cover tasks', async () => {
    const opened = await openHostRoute({
      viewport: WIDE,
      grants: [faultGrant, 'navigate', 'storage', 'haptics']
    })
    const { page, errors, scripts } = opened
    const loadedBefore = [...scripts]
    // The header's own control, by the name a user reads; it is the sidebar's on a wide layout.
    await page.getByLabel('Tasks').first().click()
    await page.waitForTimeout(1_500)
    expect(await navigates(page)).toEqual([
      { v: bridgeVersion, type: 'notify', name: 'navigate', href: `${HOST_ROUTE}/tasks` }
    ])
    // Handed over, not taken: the document stayed on the worktree list, and the tasks chunk was
    // never fetched — which is what says the page did not quietly render it under these grants.
    expect(await page.evaluate(() => location.pathname)).toBe(HOST_ROUTE)
    expect(scripts.filter((path) => !loadedBefore.includes(path))).toEqual([])
    expect(errors).toEqual([])
    await page.close()
  }, 60_000)

  it('keeps the hop in the document when the session covers tasks', async () => {
    // The same tap, the same viewport, one more grant. Without this the case above would pass on a
    // page that simply never navigates.
    const opened = await openHostRoute({
      viewport: WIDE,
      grants: [
        faultGrant,
        'navigate',
        'storage',
        'externalLink',
        'haptics',
        'native.clipboard.write'
      ]
    })
    const { page, errors } = opened
    const clickedAt = opened.jsResponses.length
    await page.getByLabel('Tasks').first().click()
    await waitForTasksRoute(page, opened, clickedAt)
    expect(await navigates(page)).toEqual([])
    expect(errors).toEqual([])
    await page.close()
  }, 60_000)

  it('hands the hop over from the narrow header too, whose control C2.10 named', async () => {
    // At this viewport `app/h/_layout.tsx` renders no sidebar, so the route's own header is the
    // narrow toolbar. C2.10 gave its Tasks control the wide sibling's role and label, so the hop
    // can be aimed at here rather than asserted absent, and the rule must hold on this branch as
    // well: the control the phone actually presses is this one.
    const opened = await openHostRoute({
      viewport: NARROW,
      grants: [faultGrant, 'navigate', 'storage', 'haptics']
    })
    const { page, errors, scripts } = opened
    const loadedBefore = [...scripts]
    const tasks = page.getByLabel('Tasks')
    // Exactly one: the narrow layout renders one toolbar, so this is the control, not a pick
    // among siblings that could have hidden a wide header rendering here.
    expect(await tasks.count()).toBe(1)
    await tasks.click()
    await page.waitForTimeout(1_500)
    expect(await navigates(page)).toEqual([
      { v: bridgeVersion, type: 'notify', name: 'navigate', href: `${HOST_ROUTE}/tasks` }
    ])
    expect(await page.evaluate(() => location.pathname)).toBe(HOST_ROUTE)
    expect(scripts.filter((path) => !loadedBefore.includes(path))).toEqual([])
    expect(errors).toEqual([])
    await page.close()
  }, 60_000)

  it('keeps the old behaviour when the shell sent no pairs at all', async () => {
    // An older shell: the page cannot tell covered from uncovered, and must not start handing
    // every hop over on the strength of a field nobody sent.
    const opened = await openHostRoute({
      viewport: WIDE,
      grants: [faultGrant, 'navigate', 'storage', 'haptics'],
      pageRouteGrants: null
    })
    const { page, errors } = opened
    const clickedAt = opened.jsResponses.length
    await page.getByLabel('Tasks').first().click()
    await waitForTasksRoute(page, opened, clickedAt)
    expect(await navigates(page)).toEqual([])
    expect(errors).toEqual([])
    await page.close()
  }, 60_000)

  it('hands the sidebar hop over from a files route too, which is the general shape', async () => {
    // The defect is not "the worktree list pushes tasks": on a wide layout the sidebar renders
    // beside EVERY `/h` route, so the same hop exists from files, whose session carries
    // `externalLink` but not `native.clipboard.write`. One opener proving it would leave the
    // general case to inference.
    const opened = await openHostRoute({
      viewport: WIDE,
      grants: [faultGrant, 'navigate', 'storage', 'externalLink', 'haptics'],
      route: FILES_ROUTE,
      awaitText: SHELL_HOST.name
    })
    const { page, errors, scripts } = opened
    const loadedBefore = [...scripts]
    await page.getByLabel('Tasks').first().click()
    await page.waitForTimeout(1_500)
    expect(await navigates(page)).toEqual([
      { v: bridgeVersion, type: 'notify', name: 'navigate', href: `${HOST_ROUTE}/tasks` }
    ])
    expect(await page.evaluate(() => location.pathname)).toBe(FILES_ROUTE)
    expect(scripts.filter((path) => !loadedBefore.includes(path))).toEqual([])
    expect(errors).toEqual([])
    await page.close()
  }, 60_000)
})

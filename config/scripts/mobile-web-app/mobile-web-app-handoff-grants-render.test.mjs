import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium } from 'playwright-core'
import { buildMobileWebAppBundle } from '../build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import {
  createBundleServer,
  waitForPageFrames,
  installShellDouble,
  readBridgeFaultGrant,
  readBridgeProtocolVersion,
  readShellCsp
} from './preview/mobile-web-app-render-harness.mjs'

// Wide sidebar pushes Tasks through useRouteHandoff; local navigation inherits opener grants and silently refuses copy actions.
// Browser check proves control is present/reachable and shell handoff leaves document in place.

const HOST_ROUTE = '/h/render-check-host'
const FILES_ROUTE = '/h/render-check-host/files/wt-1'
const HOST_PATTERN = '/h/[hostId]'
const TASKS_PATTERN = '/h/[hostId]/tasks'
/** The bundle key for the target route, so its chunk can be named rather than inferred. */
const TASKS_ROUTE_KEY = './h/[hostId]/tasks.tsx'
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
  { pathname: HOST_PATTERN, grants: ['navigate', 'storage', 'externalLink', 'haptics'] },
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
// Resolve target chunk from build; content-hash URLs cannot identify routes by name.
let tasksChunk = null

beforeAll(async () => {
  if (!bundles) {
    return
  }
  cspHeader = await readShellCsp()
  bridgeVersion = await readBridgeProtocolVersion()
  faultGrant = await readBridgeFaultGrant()
  scratch = await mkdtemp(join(tmpdir(), 'orca-mobile-web-app-handoff-'))
  const built = await buildMobileWebAppBundle({ outDir: join(scratch, 'bundle') })
  tasksChunk = built.routeChunks[TASKS_ROUTE_KEY]
  // Require resolvable target chunk or every absence assertion could pass on a typo.
  expect(tasksChunk, `no chunk for ${TASKS_ROUTE_KEY}`).toBeTruthy()
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
  awaitText = SHELL_HOST.name,
  ownsHostArea = false
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
    pageRouteGrants,
    ownsHostArea
  })
  const errors = []
  // Record every response status: failed chunk fetches must count as requests, not false evidence of no navigation.
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
  return { page, errors, jsResponses }
}

/** Every `navigate` notify the page posted, in order. */
function navigates(page) {
  return page.evaluate(() =>
    (globalThis.__orcaRenderCheckNotifies ?? []).filter((frame) => frame.name === 'navigate')
  )
}

// Race navigation wait with page errors; React Navigation throws once blanked document and hid behind a bare 30s timeout.
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
    const { page, errors, jsResponses } = opened
    // The header's own control, by the name a user reads; it is the sidebar's on a wide layout.
    await page.getByLabel('Tasks').first().click()
    await expect
      .poll(() => navigates(page))
      .toEqual([
        { v: bridgeVersion, type: 'notify', name: 'navigate', href: `${HOST_ROUTE}/tasks` }
      ])
    expect(await navigates(page)).toEqual([
      { v: bridgeVersion, type: 'notify', name: 'navigate', href: `${HOST_ROUTE}/tasks` }
    ])
    // Require original route and no target-chunk request at any status; opener chunks can still arrive after click and must not count as target navigation.
    expect(await page.evaluate(() => location.pathname)).toBe(HOST_ROUTE)
    expect(jsResponses.filter(({ path }) => path.endsWith(tasksChunk))).toEqual([])
    expect(errors).toEqual([])
    await page.close()
  }, 60_000)

  it('keeps the hop in the document when the session covers tasks', async () => {
    // Grant-positive control proves the same tap can navigate; absence alone could pass on an inert page.
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
    // Narrow layout has no sidebar; aim at C2.10 Tasks toolbar sibling and enforce same handoff rule.
    const opened = await openHostRoute({
      viewport: NARROW,
      grants: [faultGrant, 'navigate', 'storage', 'haptics']
    })
    const { page, errors, jsResponses } = opened
    const tasks = page.getByLabel('Tasks')
    // Require one narrow toolbar control or selecting among duplicates could hide a stray wide header.
    expect(await tasks.count()).toBe(1)
    await tasks.click()
    await expect
      .poll(() => navigates(page))
      .toEqual([
        { v: bridgeVersion, type: 'notify', name: 'navigate', href: `${HOST_ROUTE}/tasks` }
      ])
    expect(await navigates(page)).toEqual([
      { v: bridgeVersion, type: 'notify', name: 'navigate', href: `${HOST_ROUTE}/tasks` }
    ])
    expect(await page.evaluate(() => location.pathname)).toBe(HOST_ROUTE)
    expect(jsResponses.filter(({ path }) => path.endsWith(tasksChunk))).toEqual([])
    expect(errors).toEqual([])
    await page.close()
  }, 60_000)

  it('keeps the old behaviour when the shell sent no pairs at all', async () => {
    // Older shells omit coverage field; absence must not force every hop into shell handoff.
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

  it('draws no sidebar beside a files route in a wide viewport, so there is no hop to make', async () => {
    // Only init host-area ownership permits page sidebar; detail routes omit it to avoid duplicating shell sidebar.
    const opened = await openHostRoute({
      viewport: WIDE,
      grants: [faultGrant, 'navigate', 'storage', 'externalLink', 'haptics'],
      route: FILES_ROUTE,
      awaitText: 'Files'
    })
    const { page, errors } = opened
    await waitForPageFrames(page)
    expect(
      await page.evaluate((name) => document.body.innerText.includes(name), SHELL_HOST.name)
    ).toBe(false)
    expect(await page.getByLabel('Tasks').count()).toBe(0)
    expect(errors).toEqual([])
    await page.close()
  }, 60_000)

  it('draws the sidebar on the host route only for the session that owns the host area', async () => {
    const hostArea = await openHostRoute({
      viewport: WIDE,
      grants: [faultGrant, 'navigate', 'storage', 'externalLink', 'haptics'],
      ownsHostArea: true
    })
    // The sidebar's list beside the empty detail pane.
    await hostArea.page.getByText('No workspace open').first().waitFor({ timeout: 30_000 })
    expect(hostArea.errors).toEqual([])
    await hostArea.page.close()
    const detailOnly = await openHostRoute({
      viewport: WIDE,
      grants: [faultGrant, 'navigate', 'storage', 'externalLink', 'haptics']
    })
    await waitForPageFrames(detailOnly.page)
    expect(await detailOnly.page.getByText('No workspace open').count()).toBe(0)
    expect(detailOnly.errors).toEqual([])
    await detailOnly.page.close()
  }, 60_000)
})

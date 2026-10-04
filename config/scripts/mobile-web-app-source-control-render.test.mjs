import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
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
 * The two C4 page routes in a real browser, in the shape of the tasks and files checks.
 *
 * What only a browser answers for these: that every module in either closure imports and evaluates
 * under React Native Web, that the route paints its own screen rather than the Unmatched route, and
 * that each one's chunk arrives over the wire on a client-side navigation. The unit tests cannot say
 * any of it, because they mock react-native away — it is Flow source vitest will not parse.
 *
 * The image policy is the other thing only a browser answers: that the header the shells send is
 * the one this bundle is served under, and that neither route leaves the origin for anything while
 * it paints.
 *
 * **The avatar skip is not proved here, and this file must not look as though it is.** `img-src` is
 * `'self' data:` (rulings-ota-c4.md ruling 3), which is why `PRCommentCard` renders its empty-avatar
 * `View` on web instead of letting one `<Image>` per comment attempt a fetch the policy refuses —
 * but no comment card renders on either of these pages, because the PR chain the bottom of this file
 * names is not scripted. An assertion here that no avatar host was requested passed with the
 * platform check deleted, measured: 5 passed either way. It is gone rather than dressed up, and the
 * only proof of that branch is
 * `mobile/src/components/pr-sidebar/pr-comment-card-web-avatar.test.tsx`, which reds when the check
 * is removed.
 *
 * What survives is a property of these two closures rather than of that component: nothing either
 * route paints reaches off-origin, and nothing it paints violates the policy.
 *
 * What this file deliberately does not claim is at the bottom.
 */

const projectDir = fileURLToPath(new URL('../..', import.meta.url))
const HOST_ROUTE = '/h/render-check-host'
const WORKTREE = 'wt-1'
const HUB_ROUTE = `${HOST_ROUTE}/source-control/${WORKTREE}`
const REVIEW_ROUTE = `${HOST_ROUTE}/review/${WORKTREE}`
/** The patterns `init.pageRoutes` names, which is what the page matches a navigation against. */
const PAGE_ROUTE_PATTERNS = [HOST_ROUTE.replace('render-check-host', '[hostId]')].concat(
  '/h/[hostId]/source-control/[worktreeId]',
  '/h/[hostId]/review/[worktreeId]'
)
const SHELL_SESSION_ID = 'render-check-session'
const SHELL_BUILD_ID = 'render-check-build'
const SHELL_HOST = {
  id: 'render-check-host',
  name: 'Render Check Host',
  endpoint: 'ws://render-check',
  lastConnected: 1
}
const UNMATCHED = 'Unmatched Route'
const HUB_CHUNK_KEY = './h/[hostId]/source-control/[worktreeId].tsx'
const REVIEW_CHUNK_KEY = './h/[hostId]/review/[worktreeId].tsx'
/** Exactly what both routes declare in `MOBILE_WEB_PAGE_ROUTES`, plus the protocol's own grant. */
const C4_GRANTS = ['navigate', 'storage', 'externalLink', 'haptics', 'native.clipboard.write']

/**
 * A GitHub remote, which is what puts the PR surfaces on screen at all.
 *
 * The only reply this file scripts. Everything below it — the PR itself, its comments, the review
 * queue — is a refusal the screens have their own state for, and a double that answered them would
 * be the place domain behaviour is decided rather than a transport.
 */
const REPLIES = { 'github.repoSlug': { owner: 'orca', repo: 'orca' } }

const bundles = mobileWebAppDependenciesPresent()
const describeRender = bundles ? describe : describe.skip

let scratch
let server
let browser
let origin
let routeChunks = {}
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
  scratch = await mkdtemp(join(tmpdir(), 'orca-mobile-web-app-source-control-'))
  const built = await buildMobileWebAppBundle({ outDir: join(scratch, 'bundle') })
  routeChunks = built.routeChunks
  const served = await createBundleServer({ outDir: built.outDir, cspHeader })
  server = served.server
  origin = served.origin
  const executablePath = process.env.ORCA_MOBILE_WEB_RENDER_BROWSER
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
}, 240_000)

afterAll(async () => {
  await browser?.close()
  server?.close()
  if (scratch) {
    await rm(scratch, { recursive: true, force: true })
  }
})

/** A page carrying every signal these cases read: uncaught errors, console errors, request paths. */
async function openPage(route) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  // At document start, where the native shell installs the real channel: the entry reads it while
  // its own script runs, so a channel added after `load` would already be too late.
  await page.addInitScript(installShellDouble, {
    version: bridgeVersion,
    sessionId: SHELL_SESSION_ID,
    buildId: SHELL_BUILD_ID,
    route: { pathname: route },
    host: SHELL_HOST,
    storage: {},
    faultGrant,
    grants: [faultGrant, ...C4_GRANTS],
    pageRoutes: PAGE_ROUTE_PATTERNS,
    replies: REPLIES
  })
  const errors = []
  const scripts = []
  const requestedHosts = []
  page.on('pageerror', (error) => errors.push(`${error.name}: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(`console.error: ${message.text()}`)
    }
  })
  // Every request, not only the ones that answered: a CSP refusal fails the request, and a check
  // reading responses alone would read a blocked fetch as one that never happened.
  page.on('request', (request) => requestedHosts.push(new URL(request.url()).host))
  page.on('response', (response) => {
    const path = new URL(response.url()).pathname
    if (response.status() === 200 && path.endsWith('.js')) {
      scripts.push(path)
    }
  })
  return { page, errors, scripts, requestedHosts }
}

/**
 * Wait for the entry to mount and then for the route's own content, polled rather than read once:
 * every screen is deferred behind `import()`, so `mounted` lands while the chunk is still arriving.
 */
async function waitForRoute({ page, errors }, route, awaitText) {
  const named = (what) =>
    new Error(`${route} ${what}: ${errors.join(' | ') || 'no page or console error'}`)
  try {
    await page.waitForFunction(() => document.documentElement.dataset.orcaWebEntry === 'mounted', {
      timeout: 60_000,
      polling: 250
    })
  } catch {
    throw named('never mounted')
  }
  try {
    await page.waitForFunction((needle) => document.body.innerText.includes(needle), awaitText, {
      timeout: 60_000,
      polling: 250
    })
  } catch {
    throw named(`mounted but never painted ${JSON.stringify(awaitText)}`)
  }
  // A route that threw under the page's own error boundary names itself here rather than timing
  // out as a page that never mounted.
  for (const fault of await page.evaluate(() => globalThis.__orcaRenderCheckFaults ?? [])) {
    errors.push(`page fault: ${fault}`)
  }
}

async function openRoute(route, awaitText) {
  const opened = await openPage(route)
  await opened.page.goto(`${origin}/`, { waitUntil: 'load' })
  await waitForRoute(opened, route, awaitText)
  return opened
}

describeRender(
  'the source-control and review routes in a real browser',
  () => {
    it('mounts the source-control hub rather than the unmatched route', async () => {
      const opened = await openRoute(HUB_ROUTE, 'Source Control')
      const text = await opened.page.evaluate(() => document.body.innerText)
      // The three segment chips, which is the hub and not a header that happens to say the words.
      for (const chip of ['Changes', 'Pull Request', 'Commits']) {
        expect(text).toContain(chip)
      }
      expect(text).not.toContain(UNMATCHED)
      expect(opened.errors).toEqual([])
      await opened.page.close()
    }, 120_000)

    it('mounts diff review rather than the unmatched route', async () => {
      const opened = await openRoute(REVIEW_ROUTE, 'reviewed')
      const text = await opened.page.evaluate(() => document.body.innerText)
      // The queue filters, for the same reason the chips are read above.
      for (const filter of ['All', 'Unreviewed', 'Notes']) {
        expect(text).toContain(filter)
      }
      expect(text).not.toContain(UNMATCHED)
      expect(opened.errors).toEqual([])
      await opened.page.close()
    }, 120_000)

    it.each([
      ['source-control', HUB_ROUTE, 'Source Control', HUB_CHUNK_KEY],
      ['review', REVIEW_ROUTE, 'reviewed', REVIEW_CHUNK_KEY]
    ])(
      "fetches %s's own chunk on a client-side navigation",
      async (_name, route, text, key) => {
        const opened = await openRoute(HOST_ROUTE, SHELL_HOST.name)
        const loadedForFirstRoute = [...opened.scripts]
        await opened.page.evaluate((to) => {
          history.pushState(null, '', to)
          dispatchEvent(new PopStateEvent('popstate'))
        }, route)
        await waitForRoute(opened, route, text)
        const chunk = routeChunks[key]
        expect(chunk, Object.keys(routeChunks).join(' ')).toBeTruthy()
        // Named by the builder rather than guessed from the bytes: this is what says the route came
        // over the wire now and not out of what the first route had already loaded.
        expect(opened.scripts.filter((path) => !loadedForFirstRoute.includes(path))).toContain(
          `/assets/${chunk}`
        )
        expect(loadedForFirstRoute).not.toContain(`/assets/${chunk}`)
        await opened.page.close()
      },
      120_000
    )

    it('serves the shipped image policy and neither route violates it', async () => {
      // The policy the shells send, read from the Kotlin source rather than restated, so this
      // cannot pass against a header the app does not use.
      expect(cspHeader).toContain("img-src 'self' data: https:")
      const swift = await readFile(
        join(projectDir, 'mobile/modules/orca-mobile-web-shell/ios/MobileWebShellCsp.swift'),
        'utf8'
      )
      // The other shell says the same thing, which no served header can show.
      expect(swift).toContain(`"img-src 'self' data: https:"`)

      for (const [route, text] of [
        [HUB_ROUTE, 'Source Control'],
        [REVIEW_ROUTE, 'reviewed']
      ]) {
        const opened = await openRoute(route, text)
        // Chromium reports a refused subresource as a console error naming the directive, so
        // anything either closure loaded that the policy blocked lands here.
        expect(opened.errors.filter((entry) => entry.includes('Content Security Policy'))).toEqual(
          []
        )
        // Stronger than the line above and independent of it: not one request left the origin, so
        // there is nothing for the policy to have refused. A font, a beacon or a provider image
        // added anywhere in either closure reds this. Since the directive admits `https:`, an empty
        // list is these two closures fetching nothing rather than the policy refusing something:
        // the avatar that would fetch needs provider data this page never gets, as below.
        expect(opened.requestedHosts.filter((host) => host !== new URL(origin).host)).toEqual([])
        await opened.page.close()
      }
    }, 180_000)
  },
  600_000
)

/**
 * What this file does not claim, and where each is answered instead.
 *
 * **The PR surfaces below the trigger.** `MobilePRSidebar`, its comment cards and the `RightDrawer`
 * they sit in need `github.prForBranch` and `github.prComments` to answer, and the review queue
 * needs `worktree.show`, `repo.list` and `repo.baseRefDefault` on top of `git.status` — measured on
 * this tree by driving the page with the double. Scripting that chain would put five hand-written
 * fixtures against five Zod schemas into a transport double, which is the thing the harness's own
 * docstring says it must not become. So neither the comment avatar nor the drawer is exercised on
 * this page at all: the avatar's branch is the component test named in the header. The drawer's
 * scroll behavior belongs with the device proof, which reaches a real PR.
 *
 * **The seams.** The external-link, clipboard and router seams this series moved are each reached
 * from a control that only renders once the screens have provider data, for the same reason. They
 * are pinned by the source censuses beside them and by the host and port-pair suites.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium } from 'playwright-core'
import { buildMobileWebAppBundle } from '../build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import {
  createBundleServer,
  installShellDouble,
  readBridgeFaultGrant,
  readBridgeProtocolVersion,
  readShellCsp
} from './preview/mobile-web-app-render-harness.mjs'

// Exercise editable artifact’s draft-confirm drawer in a real browser, including portal/gesture/Reanimated paint.
// Require modal title before asserting no RN-Web BackHandler error; opening the drawer once registered an unsupported hardware-back listener.

const HOST_ROUTE = '/h/render-check-host'
const WORKTREE = 'wt-1'
const PREVIEW_ROUTE = `${HOST_ROUTE}/files/preview/${WORKTREE}`
/** The patterns `init.pageRoutes` names, which is what the page matches a navigation against. */
const PAGE_ROUTE_PATTERNS = [
  '/h/[hostId]',
  '/h/[hostId]/files/[worktreeId]',
  '/h/[hostId]/files/preview/[worktreeId]'
]
const SHELL_SESSION_ID = 'render-check-session'
const SHELL_BUILD_ID = 'render-check-build'
const SHELL_HOST = {
  id: 'render-check-host',
  name: 'Render Check Host',
  endpoint: 'ws://render-check',
  lastConnected: 1
}
/** Exactly what the preview declares in `MOBILE_WEB_PAGE_ROUTES`, plus the protocol's own grant. */
const PREVIEW_GRANTS = ['navigate', 'storage', 'externalLink', 'haptics']

// Only ready, untruncated, non-image terminal artifacts are editable; draft must differ from loaded text. Worktree files cannot reach confirmation.
const ARTIFACT_PATH = '/logs/run.txt'
const ARTIFACT_TITLE = 'run.txt'
const LOADED_CONTENT = 'hello'
const EDITED_CONTENT = 'hello, edited'
const PREVIEW_PARAMS = {
  source: 'terminalArtifact',
  absolutePath: ARTIFACT_PATH,
  grantId: 'grant-1'
}
const REPLIES = {
  'files.readTerminalArtifact': {
    content: LOADED_CONTENT,
    truncated: false,
    byteLength: LOADED_CONTENT.length
  }
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

beforeAll(async () => {
  if (!bundles) {
    return
  }
  cspHeader = await readShellCsp()
  bridgeVersion = await readBridgeProtocolVersion()
  faultGrant = await readBridgeFaultGrant()
  scratch = await mkdtemp(join(tmpdir(), 'orca-mobile-web-app-files-'))
  const built = await buildMobileWebAppBundle({ outDir: join(scratch, 'bundle') })
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

async function openPreview() {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  await page.addInitScript(installShellDouble, {
    version: bridgeVersion,
    sessionId: SHELL_SESSION_ID,
    buildId: SHELL_BUILD_ID,
    route: { pathname: PREVIEW_ROUTE, params: PREVIEW_PARAMS },
    host: SHELL_HOST,
    storage: {},
    faultGrant,
    grants: [faultGrant, ...PREVIEW_GRANTS],
    pageRoutes: PAGE_ROUTE_PATTERNS,
    replies: REPLIES
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
  return { page, errors }
}

describeRender(
  'the file preview page',
  () => {
    it('asks before discarding a draft, without registering a hardware back handler', async () => {
      const { page, errors } = await openPreview()
      // Require editor to prove loaded/editable precondition or missing prompt would pass vacuously.
      const editor = page.getByLabel(`${ARTIFACT_TITLE} editor`)
      await editor.waitFor({ timeout: 60_000 })
      await editor.fill(EDITED_CONTENT)
      await page.getByLabel('Back to files').click()

      const title = page.getByText('Discard changes?')
      await title.waitFor({ timeout: 30_000 })
      expect(await title.isVisible()).toBe(true)
      // RN-Web logs this unsupported BackHandler registration; every interactive drawer once emitted it.
      expect(errors.filter((entry) => entry.includes('BackHandler'))).toEqual([])
      await page.close()
    }, 180_000)

    it('leaves the draft alone when the answer is to stay', async () => {
      const { page } = await openPreview()
      const editor = page.getByLabel(`${ARTIFACT_TITLE} editor`)
      await editor.waitFor({ timeout: 60_000 })
      await editor.fill(EDITED_CONTENT)
      await page.getByLabel('Back to files').click()
      await page.getByText('Discard changes?').waitFor({ timeout: 30_000 })

      await page.getByText('Stay').click()
      await page.getByText('Discard changes?').waitFor({ state: 'hidden', timeout: 30_000 })
      // Still the page, still the draft: the prompt closing must not have navigated or reloaded.
      expect(await editor.inputValue()).toBe(EDITED_CONTENT)
      await page.close()
    }, 180_000)
  },
  600_000
)

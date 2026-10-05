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
 * The file preview's unsaved-draft prompt, in a real browser.
 *
 * The render check next door mounts both files routes and reads what they paint, but it never taps
 * anything, so the one control on this screen that opens a modal was unproved on the page. Two
 * things only a browser answers for it: that `ConfirmModal` — a `BottomDrawer`, and so Reanimated,
 * a portal and a gesture handler — actually paints inside the shell's page, and that opening it
 * registers no `hardwareBackPress` handler.
 *
 * The second is the whole reason this file exists. React Native Web's
 * `BackHandler.addEventListener` is a `console.error` and an inert subscription, and the drawer
 * registered one whenever it was visible and interactive. So the page's own hardware-back guard
 * being platform-gated was never the end of it: any page drawer opening put that line on the
 * console. Asserted as the absence of the line, with the modal's title as the precondition that
 * something was actually opened.
 */

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

/**
 * A terminal artifact, which is the only preview this screen lets anyone edit.
 *
 * A worktree file is read-only, so it can hold no draft and never reaches the prompt.
 * `isEditableMobileTerminalArtifactPreview` wants a ready, untruncated, non-image preview, and
 * `hasUnsavedMobileTerminalArtifactDraft` wants the draft to differ from what was loaded.
 */
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
      // The editor is the proof the artifact loaded and the screen decided it was editable; the
      // prompt is unreachable otherwise, so a missing one here would be a vacuous pass below.
      const editor = page.getByLabel(`${ARTIFACT_TITLE} editor`)
      await editor.waitFor({ timeout: 60_000 })
      await editor.fill(EDITED_CONTENT)
      await page.getByLabel('Back to files').click()

      const title = page.getByText('Discard changes?')
      await title.waitFor({ timeout: 30_000 })
      expect(await title.isVisible()).toBe(true)
      // The line react-native-web logs from `BackHandler.addEventListener`. The drawer registered
      // one on every open before it was platform-gated, so this is red without that guard.
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

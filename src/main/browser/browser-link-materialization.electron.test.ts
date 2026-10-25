import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  buildPopupIdentityProbe,
  createPopupIdentityProbeRoot,
  launchPopupIdentityProbe
} from './popup-identity-electron-probe'

const root = createPopupIdentityProbeRoot()
let probe: Awaited<ReturnType<typeof launchPopupIdentityProbe>>
let page: Page
let origin: string
const rendererErrors: string[] = []
type LinkSnapshot = {
  tabs: { id: string; sessionProfileId: string | null; sessionPartition: string | null }[]
  sourceWorkspaceId: string
  selected: string | null
  selectedUnified: string[]
  unified: { id: string; entityId: string }[]
}
const receipts: { path: string; cookie: string }[] = []
const server = createServer((request, response) => {
  receipts.push({ path: request.url ?? '', cookie: request.headers.cookie ?? '' })
  response
    .writeHead(200, { 'content-type': 'text/html' })
    .end('<title>Synthetic destination</title><p>One document, no subresources</p>')
})

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Missing HTTP port')
  }
  origin = `http://127.0.0.1:${address.port}`
  writeFileSync(
    join(root, 'preload.ts'),
    `
import { contextBridge, ipcRenderer } from 'electron'
import { browserPageInteractionAndSessionsApi } from ${JSON.stringify(join(process.cwd(), 'src/preload/api/browser-bridge-page-interaction-and-sessions.ts'))}
let heldOpen = null
contextBridge.exposeInMainWorld('probeApi', {
  browser: { ...browserPageInteractionAndSessionsApi, onOpenLinkInOrcaTab: (callback) => browserPageInteractionAndSessionsApi.onOpenLinkInOrcaTab((event) => { heldOpen = () => callback(event) }), registerGuest: (args) => ipcRenderer.invoke('link-probe:register', args) },
  fixture: {
    open: (event) => ipcRenderer.invoke('link-probe:open', event),
    pending: () => heldOpen !== null,
    release: () => { const consume = heldOpen; heldOpen = null; consume?.() },
    guests: () => ipcRenderer.invoke('link-probe:guests'),
    seed: (origin) => ipcRenderer.invoke('link-probe:seed', origin)
  }
})
`
  )
  writeFileSync(
    join(root, 'bootstrap.ts'),
    `
import { installBrowserLinkMaterializationProbe } from ${JSON.stringify(join(process.cwd(), 'src/renderer/src/hooks/ipc-events/browser-link-materialization.test-fixture.tsx'))}
try { window.linkProbe = installBrowserLinkMaterializationProbe() } catch (error) { window.linkProbeError = String(error.stack || error) }
`
  )
  writeFileSync(
    join(root, 'index.html'),
    `<!doctype html><meta charset="utf-8"><title>Real link materialization probe</title><body><script>
const noSubscribe = () => () => {}
const category = (base = {}) => new Proxy(base, { get: (target, property) => property in target ? target[property] : String(property).startsWith('on') ? noSubscribe : async () => null })
Object.defineProperty(window, 'api', { value: new Proxy({ browser: category(window.probeApi.browser), e2e: undefined, ui: category(), app: category() }, { get: (target, property) => property in target ? target[property] : category() }) })
</script><script src="./renderer.js"></script></body>`
  )
  await buildPopupIdentityProbe(root, join(root, 'preload.ts'), 'preload.cjs')
  await buildPopupIdentityProbe(root, join(root, 'bootstrap.ts'), 'renderer.js', true)
  await buildPopupIdentityProbe(
    root,
    join(process.cwd(), 'src/main/browser/browser-link-materialization-electron-fixture.ts'),
    'main.cjs'
  )
  probe = await launchPopupIdentityProbe(root)
  await vi.waitFor(
    () =>
      expect(
        probe.browser
          .contexts()
          .flatMap((context) => context.pages())
          .some((candidate) => candidate.url().endsWith('/index.html'))
      ).toBe(true),
    { timeout: 10_000 }
  )
  const found = probe.browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((candidate) => candidate.url().endsWith('/index.html'))
  if (!found) {
    throw new Error('Missing host renderer')
  }
  page = found
  page.on('pageerror', (error) => rendererErrors.push(String(error)))
}, 90_000)

afterAll(async () => {
  await probe?.stop()
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

async function ready(): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate('window.linkProbeError || Boolean(window.linkProbe)').then((ready) => {
          if (rendererErrors.length) {
            throw new Error(rendererErrors.join('\n'))
          }
          return ready
        }),
      { timeout: 10_000 }
    )
    .toBe(true)
  await page.evaluate(`window.probeApi.fixture.seed(${JSON.stringify(origin)})`)
}

async function open(activate: boolean, path: string, hold = false): Promise<void> {
  await page.evaluate(
    `window.probeApi.fixture.open({ browserPageId: window.linkProbe.sourcePageId, url: ${JSON.stringify(origin + path)}, activate: ${activate} })`
  )
  await expect.poll(() => page.evaluate('window.probeApi.fixture.pending()')).toBe(true)
  if (!hold) {
    await page.evaluate('window.probeApi.fixture.release()')
  }
}

describe('production link bridge, store and mounted guest', () => {
  it.each([false, true])(
    'materializes an isolated profile with activation=%s',
    async (activate) => {
      rendererErrors.length = 0
      await page.reload()
      await ready()
      const path = `/control-${activate}`
      await open(activate, path)
      const state = await page.evaluate<LinkSnapshot>('window.linkProbe.snapshot()')
      const created = state.tabs.find((tab) => tab.id !== state.sourceWorkspaceId)
      if (!created) {
        throw new Error('No replacement tab materialized')
      }
      expect(created).toMatchObject({
        sessionProfileId: 'isolated-profile',
        sessionPartition: 'persist:link-probe-isolated'
      })
      expect(state.selected).toBe(activate ? created.id : state.sourceWorkspaceId)
      const selectedEntity = activate ? created.id : state.sourceWorkspaceId
      const selectedUnified = state.unified.find((tab) => tab.entityId === selectedEntity)
      expect(state.selectedUnified).toContain(selectedUnified?.id)
      await page.evaluate('window.linkProbe.mountTabs()')
      await expect
        .poll(() => receipts.filter((receipt) => receipt.path === path), { timeout: 10_000 })
        .toEqual([{ path, cookie: 'synthetic_profile=isolated' }])
      await expect
        .poll(() => page.evaluate('window.probeApi.fixture.guests()'), { timeout: 10_000 })
        .toEqual([
          expect.objectContaining({ url: `${origin}${path}`, isolated: true, other: false })
        ])
    },
    25_000
  )

  it('rejects a removed source page before real store materialization', async () => {
    rendererErrors.length = 0
    await page.reload()
    await ready()
    await open(true, '/removed-page', true)
    await page.evaluate("window.linkProbe.mutate('remove-page')")
    await page.evaluate('window.probeApi.fixture.release()')
    await page.evaluate('window.linkProbe.mountTabs()')
    expect((await page.evaluate<LinkSnapshot>('window.linkProbe.snapshot()')).tabs).toHaveLength(1)
    expect(await page.evaluate('window.probeApi.fixture.guests()')).toEqual([])
    expect(receipts.some((receipt) => receipt.path === '/removed-page')).toBe(false)
  })

  // These assertions capture unsafe baseline behavior pending claim handoff repair.
  it.each(['remove-tab', 'profile-switch', 'delete-profile'])(
    'records unsafe stale-source baseline through the real mount: %s',
    async (transition) => {
      rendererErrors.length = 0
      await page.reload()
      await ready()
      const path = `/baseline-${transition}`
      await open(false, path, true)
      await page.evaluate(`window.linkProbe.mutate(${JSON.stringify(transition)})`)
      await page.evaluate('window.probeApi.fixture.release()')
      await page.evaluate('window.linkProbe.mountTabs()')
      await expect
        .poll(() => receipts.some((receipt) => receipt.path === path), { timeout: 10_000 })
        .toBe(true)
      const state = await page.evaluate<LinkSnapshot>('window.linkProbe.snapshot()')
      const replacement = state.tabs.find((tab) => tab.id !== state.sourceWorkspaceId)
      expect(replacement).toBeDefined()
      const expectedProfile = transition === 'delete-profile' ? 'isolated' : 'other'
      expect(receipts.filter((receipt) => receipt.path === path)).toEqual([
        { path, cookie: `synthetic_profile=${expectedProfile}` }
      ])
      await expect
        .poll(() => page.evaluate('window.probeApi.fixture.guests()'), { timeout: 10_000 })
        .toEqual([
          expect.objectContaining({
            url: `${origin}${path}`,
            isolated: expectedProfile === 'isolated',
            other: expectedProfile === 'other'
          })
        ])
    },
    25_000
  )

  it.todo(
    'rejects removed source tabs, profile switches and deleted profiles without a tab, mount, default fallback or destination request'
  )
  it.todo(
    'validates main-owned document/registration claims during delayed IPC consumption, async validation and deferred mount'
  )
})

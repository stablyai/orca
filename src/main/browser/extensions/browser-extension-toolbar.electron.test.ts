import { spawnProcess } from '@orca/process-host'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { build as buildVite } from 'vite'
import { bundleBrowserExtensionWorkerShim } from '../../../../config/build-plugins/browser-extension-worker-shim'
import { BROWSER_EXTENSION_WORKER_SHIM_FILE } from '../../../shared/browser-extension-worker-api'
import { resolveElectronProbeLaunch } from '../electron-probe-display-launch'

vi.setConfig({ expect: { poll: { timeout: 45_000, interval: 200 } } })

// Runs inside the extension; reports through console.log, which the fixture captures.
const REPORT = `
const report = (prefix, run) => run().then(
  (result) => console.log(prefix + JSON.stringify(result)),
  (error) => console.log(prefix + JSON.stringify({ error: String((error && error.stack) || error) }))
);
`
const WORKER_SCRIPT = `${REPORT}
report('ORCA_EXT_WORKER ', async () => {
  const [page1] = await chrome.tabs.query({ active: true });
  const created = new Promise((resolve) =>
    chrome.tabs.onCreated.addListener((tab) => resolve({ id: tab.id, windowId: tab.windowId })));
  const activated = new Promise((resolve) =>
    chrome.tabs.onActivated.addListener((info) => resolve(info.tabId)));
  await chrome.action.setBadgeText({ text: '7', tabId: page1.id });
  await chrome.action.setBadgeBackgroundColor({ color: '#ff0000' });
  await chrome.action.setTitle({ title: 'Probe title' });
  const other = (await chrome.tabs.query({})).find((tab) => tab.id !== page1.id);
  await chrome.tabs.update(other.id, { active: true });
  const activeAfter = (await chrome.tabs.query({ active: true })).map((tab) => tab.id);
  const popout = await chrome.windows.create({ url: 'page.html', type: 'popup', focused: false });
  return {
    page1: page1.id,
    other: other.id,
    badgeOnTab: await chrome.action.getBadgeText({ tabId: page1.id }),
    badgeGlobal: await chrome.action.getBadgeText({}),
    color: await chrome.action.getBadgeBackgroundColor({}),
    popup: await chrome.action.getPopup({}),
    userSettings: await chrome.action.getUserSettings(),
    activeAfter,
    activated: await activated,
    created: await created,
    popout: popout.id
  };
});
`
const POPUP_SCRIPT = `${REPORT}
report('ORCA_EXT_POPUP ', async () => ({
  active: (await chrome.tabs.query({ active: true, currentWindow: true })).map((tab) => tab.id),
  currentTab: await new Promise((resolve) => chrome.tabs.getCurrent((tab) => resolve(tab ? tab.id : null))),
  hasActionApi: typeof chrome.action.setBadgeText
}));
`

type FixtureStatus = Record<string, unknown> & {
  error?: string
  done?: boolean
  presentationCalls?: string[]
  windowsHidden?: boolean
  worker?: Record<string, unknown>
  popup?: Record<string, unknown>
}

let root = ''
let fixture: ReturnType<typeof spawnProcess> | null = null
let stderr = ''

function readStatus(): FixtureStatus {
  const path = join(root, 'status.json')
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
}

async function buildBundle(entry: string, fileName: string): Promise<void> {
  await buildVite({
    configFile: false,
    logLevel: 'silent',
    build: {
      lib: { entry, formats: ['cjs'], fileName: () => fileName },
      outDir: root,
      emptyOutDir: false,
      target: 'node22',
      minify: false,
      rollupOptions: { external: ['electron', /^node:/] }
    }
  })
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'orca-browser-extension-toolbar-'))
  const extensionDir = join(root, 'extension')
  mkdirSync(extensionDir)
  writeFileSync(
    join(extensionDir, 'manifest.json'),
    JSON.stringify({
      manifest_version: 3,
      name: 'Orca toolbar probe',
      version: '1.0.0',
      permissions: ['tabs'],
      background: { service_worker: 'worker.js' },
      action: { default_popup: 'popup.html', default_title: 'Manifest title' }
    })
  )
  writeFileSync(join(extensionDir, 'worker.js'), WORKER_SCRIPT)
  writeFileSync(join(extensionDir, 'popup.js'), POPUP_SCRIPT)
  writeFileSync(
    join(extensionDir, 'popup.html'),
    '<!doctype html><style>html,body{margin:0}body{width:320px;height:240px}</style><script src="popup.js"></script>'
  )
  writeFileSync(join(extensionDir, 'page.html'), '<!doctype html><title>page</title>')
  writeFileSync(
    join(extensionDir, 'late.html'),
    '<!doctype html><style>html,body{margin:0}</style><script src="late.js"></script>'
  )
  // No doctype: html and body stretch to the window in quirks mode; 8px body margins around 154x30.
  writeFileSync(
    join(extensionDir, 'quirks.html'),
    '<html><body><div style="width:154px;height:30px">Vue.js not detected</div></body></html>'
  )
  writeFileSync(join(extensionDir, 'veto.html'), '<!doctype html><script src="veto.js"></script>')
  writeFileSync(
    join(extensionDir, 'veto.js'),
    "onbeforeunload = (event) => { event.preventDefault(); event.returnValue = '' }; console.log('ORCA_EXT_VETO true')"
  )
  writeFileSync(
    join(extensionDir, 'late.js'),
    "setTimeout(() => { const box = document.createElement('div'); box.style.cssText = 'width:300px;height:180px'; document.body.append(box) }, 300)"
  )

  // The product resolves the preload next to its main bundle, so both land in `root`.
  await buildBundle(
    join(
      process.cwd(),
      'src/main/browser/extensions/browser-extension-toolbar-electron-fixture.ts'
    ),
    'main.cjs'
  )
  await buildBundle(
    join(process.cwd(), 'src/preload/browser-extension-preload.ts'),
    'browser-extension-preload.js'
  )
  writeFileSync(
    join(root, BROWSER_EXTENSION_WORKER_SHIM_FILE),
    (await bundleBrowserExtensionWorkerShim()).code
  )

  const electronBinary: unknown = createRequire(import.meta.url)('electron')
  if (typeof electronBinary !== 'string') {
    throw new Error('Missing Electron executable')
  }
  const { ELECTRON_RUN_AS_NODE: _runAsNode, ...env } = process.env
  const { executable, args } = resolveElectronProbeLaunch({
    electronBinary,
    electronArgs: [join(root, 'main.cjs'), `--user-data-dir=${join(root, 'profile')}`],
    platform: process.platform,
    display: env.DISPLAY
  })
  fixture = spawnProcess({
    program: executable,
    args,
    env: {
      ...env,
      ORCA_BACKGROUND_LAUNCH: '1',
      ORCA_EXTENSION_FIXTURE_STATUS: join(root, 'status.json'),
      ORCA_EXTENSION_FIXTURE_DIR: extensionDir
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  fixture.stderr?.on('data', (data: Buffer) => {
    stderr += data.toString()
  })
}, 120_000)

afterAll(async () => {
  if (fixture && fixture.exitCode === null) {
    const exited = new Promise((resolve) => fixture?.once('exit', resolve))
    fixture.kill('SIGTERM')
    await exited
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe('extension toolbar, action popup and tab activation in a real Electron session', () => {
  // Native worker, popup startup and popup resizing run through separate renderers.
  it('keeps action state per tab, opens a sized popup under the button and activates tabs', async () => {
    await expect
      .poll(() => {
        const status = readStatus()
        if (status.error) {
          throw new Error(`${status.error}\n${stderr}`)
        }
        return status.done === true
      })
      .toBe(true)
    const status = readStatus()
    const page1 = status['page-1-tab']
    const page2 = status['page-2-tab']
    expect(status.added).toEqual({ ok: true })

    expect(status.worker).toEqual({
      page1,
      other: page2,
      badgeOnTab: '7',
      badgeGlobal: '',
      color: [255, 0, 0, 255],
      popup: expect.stringMatching(/^chrome-extension:\/\/[a-p]{32}\/popup\.html$/),
      userSettings: { isOnToolbar: false },
      // tabs.update({active}) went through the renderer's tab model and was announced.
      activeAfter: [page2],
      activated: page2,
      created: { id: expect.any(Number), windowId: status.worker?.popout },
      popout: expect.any(Number)
    })
    expect(status.activationRequests).toEqual(['page-2'])

    expect(status.toolbar).toEqual({
      profileId: 'default',
      actions: [
        expect.objectContaining({
          name: 'Orca toolbar probe',
          title: 'Probe title',
          badgeText: '7',
          badgeBackgroundColor: 'rgba(255, 0, 0, 1)',
          hasPopup: true,
          enabled: true,
          pinned: false
        })
      ]
    })
    // The badge was set for page-1 only.
    expect(status.otherTabToolbar).toMatchObject({ actions: [{ badgeText: '' }] })
    expect(status.untrackedPage).toBeNull()

    expect(status.firstClick).toEqual({ ok: true })
    expect(status.popupBounds).toEqual({ width: 320, height: 240, rightAligned: true, below: true })
    // The popup has the extension APIs, sees the active tab and is not itself a tab.
    expect(status.popup).toEqual({ active: [page1], currentTab: null, hasActionApi: 'function' })
    expect(status.secondClick).toEqual({ ok: true })
    expect(status.openAfterSecondClick).toBeNull()
    expect(status.latePopupBounds).toEqual({ width: 300, height: 180 })
    expect(status.quirksPopupBounds).toEqual({ width: 170, height: 46 })
    expect(status.vetoPopupClosed).toBe(true)

    expect(status.windowsHidden).toBe(true)
    expect(status.presentationCalls).toEqual([])
  }, 120_000)
})

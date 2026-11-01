import { spawnProcess } from '@orca/process-host'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { build as buildVite } from 'vite'
import {
  bundleBrowserExtensionContentScript,
  bundleBrowserExtensionWorkerShim
} from '../../../../config/build-plugins/browser-extension-worker-shim'
import {
  BROWSER_EXTENSION_CONTENT_SCRIPT_FILE,
  BROWSER_EXTENSION_WORKER_SHIM_FILE
} from '../../../shared/browser-extension-worker-api'
import { resolveElectronProbeLaunch } from '../electron-probe-display-launch'

vi.setConfig({ expect: { poll: { timeout: 45_000, interval: 200 } } })

const API_NAMES = [
  'windows.create',
  'windows.getCurrent',
  'tabs.create',
  'tabs.remove',
  'tabs.getCurrent',
  'tabs.duplicate',
  'webNavigation.getAllFrames',
  'webNavigation.onCommitted.addListener',
  'runtime.openOptionsPage'
]

// Runs inside the extension; reports through console.log, which the fixture captures.
const SHARED_SCRIPT = `
const API_NAMES = ${JSON.stringify(API_NAMES)};
const lookup = (root, path) => path.split('.').reduce((value, key) => value && value[key], root);
const missing = (root) => root ? API_NAMES.filter((name) => typeof lookup(root, name) !== 'function') : null;
const report = (prefix, run) => run().then(
  (result) => console.log(prefix + JSON.stringify(result)),
  (error) => console.log(prefix + JSON.stringify({ error: String((error && error.stack) || error) }))
);
`
// Electron never fires storage.onChanged in workers; Orca relays the worker's and pages' writes.
const STORAGE_LISTENERS = `
const storageEvents = [];
const syncEvents = [];
chrome.storage.onChanged.addListener((changes, area) => (area === 'sync' ? syncEvents : storageEvents).push([area, changes]));
chrome.storage.sync.onChanged.addListener((changes) => syncEvents.push(['sync.onChanged', changes]));
chrome.storage.local.onChanged.addListener((changes) => storageEvents.push(['local.onChanged', changes]));
chrome.storage.session.onChanged.addListener((changes) => storageEvents.push(['session.onChanged', changes]));
const seeded = chrome.storage.local.set({ seed: 'old' });
(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  for (let i = 0; i < 150 && !storageEvents.some(([area]) => area === 'session'); i++) await sleep(100);
  await sleep(1000);
  console.log('ORCA_EXT_STORAGE ' + JSON.stringify(storageEvents));
})();
`
// Electron disables storage.sync; Orca backs it in main and fires its events in pages and workers.
const WORKER_SYNC = `
const syncWritten = chrome.storage.sync.set({ fromWorker: 1 });
(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  await syncWritten;
  for (let i = 0; i < 150 && !syncEvents.some(([, changes]) => 'fromPage' in changes); i++) await sleep(100);
  await sleep(500);
  console.log('ORCA_EXT_SYNC_WORKER ' + JSON.stringify({
    events: syncEvents,
    read: await chrome.storage.sync.get(null),
    bytes: await chrome.storage.sync.getBytesInUse(null)
  }));
})();
`
const PAGE_SYNC = `
const pageSyncEvents = [];
chrome.storage.onChanged.addListener((changes, area) => area === 'sync' && pageSyncEvents.push([area, changes]));
chrome.storage.sync.onChanged.addListener((changes) => pageSyncEvents.push(['sync.onChanged', changes]));
(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let before;
  for (let i = 0; i < 50; i++) {
    before = await chrome.storage.sync.get({ fromWorker: 0, fromPage: 'default' });
    if (before.fromWorker) break;
    await sleep(100);
  }
  await new Promise((resolve) => chrome.storage.sync.set({ fromPage: 'a' }, resolve));
  const quotaError = await new Promise((resolve) =>
    chrome.storage.sync.set({ big: 'x'.repeat(9000) }, () => resolve(chrome.runtime.lastError && chrome.runtime.lastError.message))
  );
  await sleep(500);
  console.log('ORCA_EXT_SYNC_PAGE ' + JSON.stringify({ before, events: pageSyncEvents, quotaError, quota: chrome.storage.sync.QUOTA_BYTES }));
})();
`
// A content script's storage.sync goes through the worker (Electron disables it in content scripts).
const CONTENT_SCRIPT = `
(async () => {
  const own = [];
  chrome.storage.sync.onChanged.addListener((changes) => own.push(changes));
  await chrome.storage.sync.set({ fromContent: 1 });
  const read = await chrome.storage.sync.get(['fromContent', 'fromWorker']);
  console.log('ORCA_EXT_SYNC_CONTENT ' + JSON.stringify({ read, own }));
})().catch((error) => console.log('ORCA_EXT_SYNC_CONTENT ' + JSON.stringify({ error: String(error) })));
// Chrome's content-script APIs Electron lacks, and an extension page framed in the web page.
(async () => {
  const host = document.createElement('div');
  host.attachShadow({ mode: 'open' });
  document.documentElement.append(host);
  const frame = document.createElement('iframe');
  frame.src = chrome.runtime.getURL('frame.html?in=web');
  document.documentElement.append(frame);
  console.log('ORCA_EXT_CONTENT_APIS ' + JSON.stringify({
    incognito: chrome.extension && chrome.extension.inIncognitoContext,
    shadowRoot: chrome.dom && chrome.dom.openOrClosedShadowRoot(host) === host.shadowRoot,
    managed: await chrome.storage.managed.get(null),
    managedBytes: await chrome.storage.managed.getBytesInUse(null)
  }));
})().catch((error) => console.log('ORCA_EXT_CONTENT_APIS ' + JSON.stringify({ error: String(error) })));
`
// An extension page in a subframe gets the same added APIs as a top-level one.
const FRAME_SCRIPT = `${SHARED_SCRIPT}
report(location.search.includes('in=web') ? 'ORCA_EXT_WEB_FRAME ' : 'ORCA_EXT_FRAME ', async () => ({
  chromeMissing: missing(chrome),
  permissions: typeof chrome.permissions.getAll,
  sync: await chrome.storage.sync.get(null).then(() => 'ok', (error) => String(error)),
  managed: await chrome.storage.managed.get(null)
}));
`
const WORKER_SCRIPT = `${SHARED_SCRIPT}${STORAGE_LISTENERS}${WORKER_SYNC}
report('ORCA_EXT_WORKER ', async () => {
  await seeded;
  const hasBrowser = typeof browser !== 'undefined';
  const activeTabs = (await chrome.tabs.query({ active: true })).map((tab) => tab.id);
  return {
    chromeMissing: missing(chrome),
    browserMissing: hasBrowser ? missing(browser) : 'no browser global',
    currentWindow: (await chrome.windows.getCurrent()).id,
    windowsViaCallback: await new Promise((resolve) => chrome.windows.getAll((windows) => resolve(windows.map((w) => w.id)))),
    activeTabs,
    activeTabsViaBrowser: hasBrowser ? (await browser.tabs.query({ active: true, currentWindow: true })).map((tab) => tab.id) : null,
    frames: await new Promise((resolve) =>
      chrome.webNavigation.getAllFrames({ tabId: activeTabs[0] }, (frames) => resolve(frames && frames.map((f) => [f.frameId, f.parentFrameId])))
    ),
    lastError: await new Promise((resolve) =>
      chrome.windows.get(999999, () => resolve(chrome.runtime.lastError && chrome.runtime.lastError.message))
    ),
    popout: (await chrome.windows.create({ url: 'page.html', type: 'popup', focused: false })).id
  };
});
`
const PAGE_SCRIPT = `${SHARED_SCRIPT}${PAGE_SYNC}
(async () => {
  await chrome.storage.local.set({ seed: 'new', added: 1 });
  await chrome.storage.local.set({ seed: 'new' });
  await chrome.storage.session.set({ token: 'abc' });
})();
report('ORCA_EXT_PAGE ', async () => ({
  chromeMissing: missing(chrome),
  browserMissing: typeof browser !== 'undefined' ? missing(browser) : 'no browser global',
  currentWindow: (await chrome.windows.getCurrent()).id,
  currentTab: await new Promise((resolve) => chrome.tabs.getCurrent((tab) => resolve(tab && tab.id)))
}));
`

type FixtureStatus = {
  error?: string
  hostWindowId?: number
  guestId?: number
  popoutContentsId?: number | null
  windowsHidden?: boolean
  presentationCalls?: string[]
  added?: { ok: boolean; error?: string }
  worker?: Record<string, unknown>
  page?: Record<string, unknown>
  storage?: unknown[]
  syncWorker?: Record<string, unknown>
  syncPage?: Record<string, unknown>
  syncContent?: Record<string, unknown>
  contentApis?: Record<string, unknown>
  frame?: Record<string, unknown>
  webFrame?: Record<string, unknown>
  sandbox?: Record<string, unknown>
  webPageCall?: unknown
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
  root = mkdtempSync(join(tmpdir(), 'orca-browser-extension-'))
  const extensionDir = join(root, 'extension')
  mkdirSync(extensionDir)
  writeFileSync(
    join(extensionDir, 'manifest.json'),
    JSON.stringify({
      manifest_version: 3,
      name: 'Orca API probe',
      version: '1.0.0',
      permissions: ['tabs', 'webNavigation', 'storage'],
      // A module worker under a policy that limits connect-src: the wrapper must still reach main.
      // `scripts` is Firefox's key, which Refined GitHub ships alongside service_worker.
      background: { service_worker: 'worker.js', type: 'module', scripts: ['worker.js'] },
      content_scripts: [{ matches: ['http://127.0.0.1/*'], js: ['content.js'] }],
      content_security_policy: {
        extension_pages: "script-src 'self'; object-src 'self'; connect-src https://vault.invalid"
      },
      options_ui: { page: 'page.html' },
      sandbox: { pages: ['sandboxed.html'] },
      web_accessible_resources: [
        { resources: ['frame.html', 'frame.js'], matches: ['http://127.0.0.1/*'] }
      ]
    })
  )
  writeFileSync(join(extensionDir, 'worker.js'), WORKER_SCRIPT)
  writeFileSync(join(extensionDir, 'page.js'), PAGE_SCRIPT)
  writeFileSync(join(extensionDir, 'content.js'), CONTENT_SCRIPT)
  writeFileSync(
    join(extensionDir, 'page.html'),
    '<!doctype html><script src="page.js"></script><iframe src="frame.html"></iframe>'
  )
  writeFileSync(join(extensionDir, 'frame.js'), FRAME_SCRIPT)
  writeFileSync(join(extensionDir, 'frame.html'), '<!doctype html><script src="frame.js"></script>')
  // Chrome removes extension APIs from manifest sandbox pages; Orca's bridge must not restore them.
  writeFileSync(
    join(extensionDir, 'sandboxed.js'),
    `const getAll = globalThis.chrome?.windows?.getAll
    const report = (outcome) => console.log('ORCA_EXT_SANDBOX ' + JSON.stringify({ origin: self.origin, getAll: typeof getAll, outcome }))
    if (typeof getAll === 'function') {
      Promise.resolve(getAll({ populate: true })).then((windows) => report('answered ' + windows.length), (error) => report('refused ' + String(error)))
    } else {
      report('unavailable')
    }`
  )
  writeFileSync(
    join(extensionDir, 'sandboxed.html'),
    '<!doctype html><script src="sandboxed.js"></script>'
  )

  // The product resolves the preload next to its main bundle, so both land in `root`.
  await buildBundle(
    join(process.cwd(), 'src/main/browser/extensions/browser-extension-electron-fixture.ts'),
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
  writeFileSync(
    join(root, BROWSER_EXTENSION_CONTENT_SCRIPT_FILE),
    (await bundleBrowserExtensionContentScript()).code
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

describe('browser extension APIs in a real Electron session', () => {
  // Native worker and popup startup can require extra time across renderers.
  it('gives an MV3 worker and extension page the added APIs on chrome and browser', async () => {
    await expect
      .poll(() => {
        const status = readStatus()
        if (status.error) {
          throw new Error(`${status.error}\n${stderr}`)
        }
        return Boolean(status.worker && status.page)
      })
      .toBe(true)
    const status = readStatus()
    expect(status.added).toEqual({ ok: true })

    expect(status.worker).toEqual({
      chromeMissing: [],
      browserMissing: [],
      currentWindow: status.hostWindowId,
      windowsViaCallback: expect.arrayContaining([status.hostWindowId]),
      activeTabs: [status.guestId],
      activeTabsViaBrowser: [status.guestId],
      frames: [[0, -1]],
      lastError: 'No window with id: 999999.',
      popout: expect.any(Number)
    })
    // A popout page's "current" window and tab are its own, not Orca's main window.
    expect(status.page).toEqual({
      chromeMissing: [],
      browserMissing: [],
      currentWindow: status.worker?.popout,
      currentTab: status.popoutContentsId
    })
    expect(status.windowsHidden).toBe(true)
    expect(status.presentationCalls).toEqual([])
  }, 120_000)

  it('fires the worker storage.onChanged and area events once for its own and its pages writes', async () => {
    await expect.poll(() => readStatus().storage).toBeDefined()
    const seeded = { seed: { newValue: 'old' } }
    const pageLocal = { seed: { oldValue: 'old', newValue: 'new' }, added: { newValue: 1 } }
    const pageSession = { token: { newValue: 'abc' } }
    expect(readStatus().storage).toEqual([
      ['local.onChanged', seeded],
      ['local', seeded],
      ['local.onChanged', pageLocal],
      ['local', pageLocal],
      ['session.onChanged', pageSession],
      ['session', pageSession]
    ])
  })

  it('backs storage.sync in main and fires its changes in the worker and the page', async () => {
    await expect.poll(() => Boolean(readStatus().syncWorker && readStatus().syncPage)).toBe(true)
    const fromWorker = { fromWorker: { newValue: 1 } }
    const fromPage = { fromPage: { newValue: 'a' } }
    expect(readStatus().syncWorker).toEqual({
      events: [
        ['sync.onChanged', fromWorker],
        ['sync', fromWorker],
        ['sync.onChanged', fromPage],
        ['sync', fromPage]
      ],
      read: { fromWorker: 1, fromPage: 'a' },
      bytes: 'fromWorker1'.length + 'fromPage"a"'.length
    })
    expect(readStatus().syncPage).toEqual({
      before: { fromWorker: 1, fromPage: 'default' },
      events: [
        ['sync.onChanged', fromPage],
        ['sync', fromPage]
      ],
      quotaError: 'QUOTA_BYTES_PER_ITEM quota exceeded',
      quota: 102_400
    })
  })

  it('gives a content script storage.sync through the worker, which starts cleanly', async () => {
    await expect.poll(() => readStatus().syncContent).toBeDefined()
    expect(readStatus().syncContent).toEqual({
      read: { fromContent: 1, fromWorker: 1 },
      own: [{ fromContent: { newValue: 1 } }]
    })
    expect(stderr).not.toContain('Could not start extension worker')
    expect(stderr).not.toContain("'background.scripts' requires manifest version")
  })

  it('gives an extension page framed in a popout or a web page the same added APIs', async () => {
    await expect.poll(() => Boolean(readStatus().frame && readStatus().webFrame)).toBe(true)
    const expected = { chromeMissing: [], permissions: 'function', sync: 'ok', managed: {} }
    expect(readStatus().frame).toEqual(expected)
    expect(readStatus().webFrame).toEqual(expected)
  })

  it('gives content scripts chrome.extension, chrome.dom and an empty storage.managed', async () => {
    await expect.poll(() => readStatus().contentApis).toBeDefined()
    expect(readStatus().contentApis).toEqual({
      incognito: false,
      shadowRoot: true,
      managed: {},
      managedBytes: 0
    })
  })

  it('gives a manifest sandbox page none of the extension APIs, as Chrome does', async () => {
    await expect.poll(() => readStatus().sandbox).toBeDefined()
    expect(readStatus().sandbox).toEqual({
      origin: 'null',
      getAll: 'undefined',
      outcome: 'unavailable'
    })
  })

  it('gives a web page in the same session no answer from the worker API', async () => {
    await expect.poll(() => readStatus().webPageCall).toBeDefined()
    expect(readStatus().webPageCall).not.toBe(200)
  })
})

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

// Creates its menus and script only on the first run, as extensions that use onInstalled do.
const WORKER_SCRIPT = `
chrome.commands.onCommand.addListener((name, tab) =>
  console.log('ORCA_EXT_COMMAND ' + JSON.stringify({ name, hasTab: Boolean(tab && tab.id) }))
);
chrome.webRequest.onCompleted.addListener(
  (d) => console.log('ORCA_EXT_WEBREQUEST ' + JSON.stringify({ path: new URL(d.url).pathname, type: d.type, tabId: d.tabId, statusCode: d.statusCode })),
  { urls: ['http://127.0.0.1/*'], types: ['main_frame'] }
);
chrome.storage.sync.get(null).then((items) => console.log('ORCA_EXT_SYNC ' + JSON.stringify(items)));
chrome.storage.local.get('setup').then(async ({ setup }) => {
  if (setup) return;
  await chrome.storage.sync.set({ remembered: { dark: true } });
  chrome.contextMenus.create({ id: 'fill', title: 'Fill field', contexts: ['editable'] });
  chrome.contextMenus.create({ id: 'generate', title: 'Generate password', contexts: ['editable'] });
  await chrome.scripting.registerContentScripts([
    { id: 'marker', matches: ['http://127.0.0.1/*'], js: ['cs.js'], runAt: 'document_end', persistAcrossSessions: true }
  ]);
  await chrome.storage.local.set({ setup: true });
  const registered = (await chrome.scripting.getRegisteredContentScripts()).map((s) => s.id);
  console.log('ORCA_EXT_SETUP ' + JSON.stringify({ registered }));
}).catch((error) => console.log('ORCA_EXT_ERROR ' + String(error)));
`

type FixtureStatus = {
  error?: string
  added?: { ok: boolean; error?: string }
  setup?: { registered: string[] }
  contentScript?: { path: string }
  webRequest?: Record<string, unknown>
  sync?: Record<string, unknown>
  menu?: unknown
  commands?: unknown[]
  windowsHidden?: boolean
  presentationCalls?: string[]
}

let root = ''
let extensionDir = ''
let running: ReturnType<typeof spawnProcess> | null = null
let stderr = ''

function readStatus(phase: string): FixtureStatus {
  const path = join(root, `status-${phase}.json`)
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

function launch(phase: 'first' | 'second'): ReturnType<typeof spawnProcess> {
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
  const child = spawnProcess({
    program: executable,
    args,
    env: {
      ...env,
      ORCA_BACKGROUND_LAUNCH: '1',
      ORCA_EXTENSION_FIXTURE_STATUS: join(root, `status-${phase}.json`),
      ORCA_EXTENSION_FIXTURE_DIR: extensionDir,
      ORCA_EXTENSION_FIXTURE_PHASE: phase
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stderr?.on('data', (data: Buffer) => {
    stderr += data.toString()
  })
  running = child
  return child
}

function pollStatus(phase: string, ready: (status: FixtureStatus) => boolean) {
  return expect
    .poll(() => {
      const status = readStatus(phase)
      if (status.error) {
        throw new Error(`${status.error}\n${stderr}`)
      }
      return ready(status)
    })
    .toBe(true)
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'orca-browser-extension-persistence-'))
  extensionDir = join(root, 'extension')
  mkdirSync(extensionDir)
  writeFileSync(
    join(extensionDir, 'manifest.json'),
    JSON.stringify({
      manifest_version: 3,
      name: 'Orca persistence probe',
      version: '1.0.0',
      permissions: ['contextMenus', 'scripting', 'storage', 'webRequest'],
      host_permissions: ['http://127.0.0.1/*'],
      background: { service_worker: 'worker.js' },
      commands: {
        fill_login: { suggested_key: { default: 'Ctrl+Shift+L' }, description: 'Fill' },
        orca_owned: { suggested_key: { default: 'Ctrl+Shift+F' }, description: 'Taken by Orca' }
      }
    })
  )
  writeFileSync(join(extensionDir, 'worker.js'), WORKER_SCRIPT)
  writeFileSync(
    join(extensionDir, 'cs.js'),
    "console.log('ORCA_EXT_CONTENT_SCRIPT ' + JSON.stringify({ path: location.pathname }))"
  )
  await buildBundle(
    join(
      process.cwd(),
      'src/main/browser/extensions/browser-extension-persistence-electron-fixture.ts'
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
}, 120_000)

afterAll(async () => {
  if (running && running.exitCode === null) {
    const exited = new Promise((resolve) => running?.once('exit', resolve))
    running.kill('SIGTERM')
    await exited
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe('browser extension state across a restart', () => {
  // Two Electron launches and native worker startup need separate readiness budgets.
  it('replays menus and persistAcrossSessions scripts; forwards webRequest and commands', async () => {
    const first = launch('first')
    const firstExited = new Promise((resolve) => first.once('exit', resolve))
    await pollStatus('first', (status) => Boolean(status.setup))
    expect(readStatus('first').added).toEqual({ ok: true })
    expect(readStatus('first').setup).toEqual({ registered: ['marker'] })
    await firstExited

    launch('second')
    await pollStatus('second', (status) =>
      Boolean(status.contentScript && status.webRequest && status.menu !== undefined)
    )
    const status = readStatus('second')
    // Orca keeps sync storage across a restart (Electron disables the native area).
    await pollStatus('second', (current) => Boolean(current.sync))
    expect(readStatus('second').sync).toEqual({ remembered: { dark: true } })
    // Electron forgot the script; Orca re-registered it before the tab's first load.
    expect(status.contentScript).toEqual({ path: '/login' })
    expect(status.webRequest).toEqual({
      path: '/login',
      type: 'main_frame',
      tabId: expect.any(Number),
      statusCode: 200
    })
    // The worker did not create menus this run; they came back from Orca's saved state.
    expect(status.menu).toEqual([
      {
        extensionId: expect.any(String),
        items: [
          expect.objectContaining({
            title: 'Orca persistence probe',
            children: [
              expect.objectContaining({ key: '"fill"', title: 'Fill field' }),
              expect.objectContaining({ key: '"generate"', title: 'Generate password' })
            ]
          })
        ]
      }
    ])
    // Command shortcuts typed into the tab reach the extension unless Orca owns the keys.
    await pollStatus('second', (current) => Boolean(current.commands))
    // ast-grep-ignore: test-no-real-time-wait -- Observe late forbidden shortcut deliveries from the separate Electron worker.
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(readStatus('second').commands).toEqual([{ name: 'fill_login', hasTab: true }])
    expect(status.windowsHidden).toBe(true)
    expect(status.presentationCalls).toEqual([])
  }, 180_000)
})

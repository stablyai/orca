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

// Appends every lifecycle event to storage, so a repeat in any launch shows in the list.
const WORKER_SCRIPT = `
let chain = Promise.resolve();
const record = (entry) => {
  chain = chain.then(async () => {
    const { events = [] } = await chrome.storage.local.get('events');
    events.push({ ...entry, version: chrome.runtime.getManifest().version });
    await chrome.storage.local.set({ events });
    console.log('ORCA_EXT_LIFECYCLE ' + JSON.stringify(events));
  });
};
chrome.runtime.onInstalled.addListener((details) => record({ event: 'onInstalled', details }));
chrome.runtime.onStartup.addListener(() => record({ event: 'onStartup' }));
`

type Phase = 'install' | 'restart' | 'update'
type FixtureStatus = {
  error?: string
  added?: { ok: boolean; error?: string }
  reloaded?: { ok: boolean; error?: string }
  events?: unknown[]
  done?: boolean
  presentationCalls?: string[]
}

let root = ''
let extensionDir = ''
let running: ReturnType<typeof spawnProcess> | null = null
let stderr = ''

function readStatus(phase: Phase): FixtureStatus {
  const path = join(root, `status-${phase}.json`)
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
}

function writeManifest(version: string): void {
  writeFileSync(
    join(extensionDir, 'manifest.json'),
    JSON.stringify({
      manifest_version: 3,
      name: 'Orca lifecycle probe',
      version,
      permissions: ['storage'],
      background: { service_worker: 'worker.js' }
    })
  )
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

/** Runs one launch until the fixture quits after its events settle. */
async function runPhase(phase: Phase): Promise<FixtureStatus> {
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
  const exited = new Promise((resolve) => child.once('exit', resolve))
  await expect
    .poll(() => {
      const status = readStatus(phase)
      if (status.error) {
        throw new Error(`${status.error}\n${stderr}`)
      }
      return status.done === true
    })
    .toBe(true)
  await exited
  return readStatus(phase)
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'orca-browser-extension-lifecycle-'))
  extensionDir = join(root, 'extension')
  mkdirSync(extensionDir)
  writeManifest('1.0.0')
  writeFileSync(join(extensionDir, 'worker.js'), WORKER_SCRIPT)
  await buildBundle(
    join(
      process.cwd(),
      'src/main/browser/extensions/browser-extension-lifecycle-electron-fixture.ts'
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

describe('runtime.onInstalled and onStartup across launches', () => {
  it('installs once, starts up on the next launch, and updates on a new version or reload', async () => {
    const install = { event: 'onInstalled', details: { reason: 'install' }, version: '1.0.0' }
    const startup = { event: 'onStartup', version: '1.0.0' }
    const first = await runPhase('install')
    expect(first.added).toEqual({ ok: true })
    expect(first.events).toEqual([install])

    const second = await runPhase('restart')
    expect(second.events).toEqual([install, startup])

    // The unpacked folder changes between launches, then Settings › Reload copies it again.
    writeManifest('2.0.0')
    const third = await runPhase('update')
    expect(third.reloaded).toEqual({ ok: true })
    expect(third.events?.slice(0, 2)).toEqual([install, startup])
    expect(third.events?.slice(2, 4)).toHaveLength(2)
    expect(third.events?.slice(2, 4)).toEqual(
      expect.arrayContaining([
        { event: 'onStartup', version: '2.0.0' },
        {
          event: 'onInstalled',
          details: { reason: 'update', previousVersion: '1.0.0' },
          version: '2.0.0'
        }
      ])
    )
    expect(third.events?.[4]).toEqual({
      event: 'onInstalled',
      details: { reason: 'update', previousVersion: '2.0.0' },
      version: '2.0.0'
    })
    expect(third.events).toHaveLength(5)
    expect(third.presentationCalls).toEqual([])
  }, 240_000)
})

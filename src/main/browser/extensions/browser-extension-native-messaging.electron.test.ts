import { spawnProcess } from '@orca/process-host'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
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

vi.setConfig({ testTimeout: 60_000, expect: { poll: { timeout: 45_000, interval: 200 } } })

// A Chrome-style host: length-prefixed JSON both ways. It ignores stdin closing, so only Orca
// killing it ends it.
const ECHO_HOST = `
const le = require('os').endianness() === 'LE';
let buffered = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buffered = Buffer.concat([buffered, chunk]);
  while (buffered.length >= 4) {
    const size = le ? buffered.readUInt32LE(0) : buffered.readUInt32BE(0);
    if (buffered.length < 4 + size) return;
    const message = JSON.parse(buffered.subarray(4, 4 + size).toString('utf8'));
    buffered = buffered.subarray(4 + size);
    const body = Buffer.from(JSON.stringify({ echo: message, pid: process.pid, argv: process.argv.slice(2) }));
    const head = Buffer.alloc(4);
    le ? head.writeUInt32LE(body.length) : head.writeUInt32BE(body.length);
    process.stdout.write(Buffer.concat([head, body]));
  }
});
process.stdin.on('end', () => {});
setInterval(() => {}, 1000);
`
const EXIT_HOST = 'process.exit(0)'

const SHARED = `
const log = (key, value) => console.log('ORCA_NM ' + JSON.stringify({ key, value }));
const lastError = () => (chrome.runtime.lastError ? chrome.runtime.lastError.message : null);
const firstEvent = (port) => new Promise((resolve) => {
  port.onMessage.addListener((message) => resolve({ message }));
  port.onDisconnect.addListener(() => resolve({ disconnected: lastError() }));
});
`
const WORKER_SCRIPT = `${SHARED}
(async () => {
  log('popout', (await chrome.windows.create({ url: 'page.html', type: 'popup', focused: false })).id);
  const port = chrome.runtime.connectNative('com.orca.echo');
  const echoed = firstEvent(port);
  port.postMessage({ text: 'héllo 🦈', from: 'worker' });
  log('workerEcho', await echoed);
  port.disconnect();
  log('workerDisconnected', true);
  log('oneShot', await chrome.runtime.sendNativeMessage('com.orca.echo', { once: true }));
  log('missing', await firstEvent(chrome.runtime.connectNative('com.orca.missing')));
  log('forbidden', await chrome.runtime.sendNativeMessage('com.orca.forbidden', {}).then(() => 'replied', (error) => error.message));
  log('exit', await firstEvent(chrome.runtime.connectNative('com.orca.exit')));
  log('oneShotExit', await new Promise((resolve) =>
    chrome.runtime.sendNativeMessage('com.orca.exit', {}, (response) => resolve({ response, error: lastError() }))
  ));
  const lingering = chrome.runtime.connectNative('com.orca.echo');
  const pong = firstEvent(lingering);
  lingering.postMessage('ping');
  log('lingering', await pong);
})().catch((error) => log('workerError', String((error && error.stack) || error)));
`
const PAGE_SCRIPT = `${SHARED}
const port = chrome.runtime.connectNative('com.orca.echo');
firstEvent(port).then((event) => log('pageEcho', event));
port.postMessage({ from: 'page' });
`

type EchoEvent = { message?: { echo: unknown; pid: number; argv: string[] }; disconnected?: string }
type FixtureStatus = Record<string, unknown> & {
  error?: string
  workerError?: string
  workerEcho?: EchoEvent
  pageEcho?: EchoEvent
  lingering?: EchoEvent
  oneShot?: { echo: unknown; pid: number }
}

let root = ''
let fixture: ReturnType<typeof spawnProcess> | null = null
let stderr = ''

function readStatus(): FixtureStatus {
  const path = join(root, 'status.json')
  if (!existsSync(path)) {
    return {}
  }
  const status: FixtureStatus = JSON.parse(readFileSync(path, 'utf8'))
  if (status.error || status.workerError) {
    throw new Error(`${status.error ?? status.workerError}\n${stderr}`)
  }
  return status
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** A launcher like the ones desktop apps register: a script on POSIX, a .cmd on Windows. */
function writeHost(name: string, source: string): string {
  const script = join(root, `${name}.js`)
  writeFileSync(script, source)
  if (process.platform === 'win32') {
    const launcher = join(root, `${name}.cmd`)
    writeFileSync(launcher, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`)
    return launcher
  }
  const launcher = join(root, name)
  writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`)
  chmodSync(launcher, 0o755)
  return launcher
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
  root = mkdtempSync(join(tmpdir(), 'orca-native-messaging-'))
  const extensionDir = join(root, 'extension')
  mkdirSync(extensionDir)
  writeFileSync(
    join(extensionDir, 'manifest.json'),
    JSON.stringify({
      manifest_version: 3,
      name: 'Orca native messaging probe',
      version: '1.0.0',
      permissions: ['nativeMessaging'],
      background: { service_worker: 'worker.js' }
    })
  )
  writeFileSync(join(extensionDir, 'worker.js'), WORKER_SCRIPT)
  writeFileSync(join(extensionDir, 'page.js'), PAGE_SCRIPT)
  writeFileSync(join(extensionDir, 'page.html'), '<!doctype html><script src="page.js"></script>')

  await buildBundle(
    join(
      process.cwd(),
      'src/main/browser/extensions/browser-extension-native-messaging-electron-fixture.ts'
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
      ORCA_EXTENSION_FIXTURE_DIR: extensionDir,
      ORCA_NATIVE_FIXTURE_USER_DATA: join(root, 'profile'),
      ORCA_NATIVE_FIXTURE_ECHO_HOST: writeHost('echo-host', ECHO_HOST),
      ORCA_NATIVE_FIXTURE_EXIT_HOST: writeHost('exit-host', EXIT_HOST)
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
  // A failed run must not leave its hosts behind.
  const status = existsSync(join(root, 'status.json'))
    ? JSON.parse(readFileSync(join(root, 'status.json'), 'utf8'))
    : {}
  for (const event of [status.workerEcho, status.pageEcho, status.lingering]) {
    const pid: unknown = event?.message?.pid
    if (typeof pid === 'number' && isRunning(pid)) {
      process.kill(pid, 'SIGKILL')
    }
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe('chrome.runtime native messaging in a real Electron session', () => {
  it('round-trips with a registered host from the worker, passing Chrome’s arguments', async () => {
    await expect.poll(() => readStatus().workerEcho).toBeDefined()
    const { message } = readStatus().workerEcho ?? {}
    expect(message?.echo).toEqual({ text: 'héllo 🦈', from: 'worker' })
    expect(message?.argv[0]).toMatch(/^chrome-extension:\/\/[a-p]{32}\/$/)
    expect(message?.argv.slice(1)).toEqual(
      process.platform === 'win32' ? ['--parent-window=0'] : []
    )
  })

  it('kills the host when the worker disconnects its port', async () => {
    await expect.poll(() => readStatus().workerDisconnected).toBe(true)
    const pid = readStatus().workerEcho?.message?.pid ?? 0
    await expect.poll(() => isRunning(pid)).toBe(false)
  })

  it('answers sendNativeMessage once and kills that host after the reply', async () => {
    await expect.poll(() => readStatus().oneShot).toBeDefined()
    const reply = readStatus().oneShot
    expect(reply?.echo).toEqual({ once: true })
    await expect.poll(() => isRunning(reply?.pid ?? 0)).toBe(false)
  })

  it('reports a missing host, a forbidden extension and an exiting host with Chrome’s errors', async () => {
    await expect.poll(() => readStatus().oneShotExit).toBeDefined()
    const status = readStatus()
    expect(status.missing).toEqual({ disconnected: 'Specified native messaging host not found.' })
    expect(status.forbidden).toBe('Access to the specified native messaging host is forbidden.')
    expect(status.exit).toEqual({ disconnected: 'Native host has exited.' })
    expect(status.oneShotExit).toEqual({ error: 'Native host has exited.' })
  })

  it('round-trips from an extension page and kills its host when the page closes', async () => {
    await expect.poll(() => readStatus().pageEcho).toBeDefined()
    const { message } = readStatus().pageEcho ?? {}
    expect(message?.echo).toEqual({ from: 'page' })
    await expect.poll(() => isRunning(message?.pid ?? 0)).toBe(false)
    expect(readStatus().windowsHidden).toBe(true)
    expect(readStatus().presentationCalls).toEqual([])
  })

  it('kills a host whose port is still open when Orca quits', async () => {
    await expect.poll(() => readStatus().lingering).toBeDefined()
    const pid = readStatus().lingering?.message?.pid ?? 0
    expect(isRunning(pid)).toBe(true)
    const exited = new Promise((resolve) => fixture?.once('exit', resolve))
    writeFileSync(join(root, 'status.json.quit'), '')
    await exited
    await expect.poll(() => isRunning(pid)).toBe(false)
  })
})

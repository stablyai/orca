import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { builtinModules, createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { build as buildVite } from 'vite'
import { resolveElectronProbeLaunch } from '../browser/electron-probe-display-launch'
import { REMOTE_RUNTIME_SOCKET_PING_INTERVAL_MS } from '../../shared/remote-runtime-socket-liveness'
import { REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY } from '../../shared/protocol-version'
import { encodePairingOffer } from '../../shared/pairing'
import {
  addEnvironmentFromPairingCode,
  removeEnvironment
} from '../../shared/runtime-environment-store'
import {
  closeSharedControlTestServers,
  createSharedControlTestServer
} from '../../shared/remote-runtime-shared-control-test-server'

// Why a real Electron process: the registration in `runtime-environments.ts` that hands the removal
// watch its user-data path and its teardown only runs inside the shipped main process, and the
// retirement rides the socket's own liveness timer. A vitest-only harness can reach neither, so
// #20995 -- the CLI removes an environment and the app keeps the socket -- could only be reproduced
// here. The store rewrite is issued from this process, which is what `orca environment rm` is.

const electronBinary = resolveElectronBinary()
const roots: string[] = []
let child: ChildProcess | null = null

afterAll(async () => {
  child?.kill('SIGKILL')
  await closeSharedControlTestServers()
  if (process.env.ORCA_KEEP_FIXTURE === '1') {
    return
  }
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

function resolveElectronBinary(): string {
  const resolved: unknown = createRequire(import.meta.url)('electron')
  if (typeof resolved !== 'string') {
    throw new Error('The electron package did not resolve to a binary path')
  }
  return resolved
}

function buildFixtureMain(bundlePath: string, logPath: string): string {
  return [
    `const { app } = require('electron')`,
    `const { appendFileSync } = require('node:fs')`,
    `const log = (message) => appendFileSync(${JSON.stringify(logPath)}, message + '\\n')`,
    `process.on('uncaughtException', (error) => log('uncaught ' + (error && error.stack)))`,
    `process.on('unhandledRejection', (error) => log('unhandled ' + (error && error.stack)))`,
    `app.whenReady().then(() => {`,
    `  log('ready ' + app.getPath('userData'))`,
    `  require(${JSON.stringify(bundlePath)}).registerRuntimeEnvironmentHandlers({ getSettings: () => ({}) })`,
    `  log('registered')`,
    `}).catch((error) => log('ready-failed ' + (error && error.stack)))`
  ].join('\n')
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  what: () => string
): Promise<void> {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out waiting for ${what()}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

function readFixtureLog(root: string): string {
  const path = join(root, 'fixture.log')
  return existsSync(path) ? readFileSync(path, 'utf8') : '(no fixture log)'
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('runtime environment removed by the CLI', () => {
  it('drops the live socket the desktop app was holding and never reconnects', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-cli-removal-'))
    roots.push(root)
    const userDataPath = join(root, 'profile')
    mkdirSync(userDataPath, { recursive: true })
    const fixtureDir = join(root, 'fixture')
    mkdirSync(fixtureDir, { recursive: true })

    // The app only keeps a standing shared-control socket for a host that advertises the capability.
    const server = await createSharedControlTestServer({
      resultForRequest: (method) =>
        method === 'status.get'
          ? { capabilities: [REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY], runtimeId: 'runtime-test' }
          : { method }
    })
    const environment = addEnvironmentFromPairingCode(userDataPath, {
      name: 'removal-host',
      pairingCode: encodePairingOffer(server.pairing)
    })

    const entryPath = join(fixtureDir, 'entry.ts')
    writeFileSync(
      entryPath,
      `export { registerRuntimeEnvironmentHandlers } from ${JSON.stringify(join(process.cwd(), 'src/main/ipc/runtime-environments.ts'))}`
    )
    await buildVite({
      configFile: false,
      logLevel: 'silent',
      // Why `node` conditions and the bare-builtin externals: the default browser resolution stubs
      // `crypto` and the bundle throws on load instead of running the shipped code.
      resolve: { conditions: ['node'] },
      build: {
        emptyOutDir: false,
        lib: { entry: entryPath, formats: ['cjs'], fileName: () => 'runtime-environments.cjs' },
        outDir: fixtureDir,
        target: 'node20',
        rollupOptions: { external: ['electron', /^node:/, ...builtinModules] }
      }
    })

    writeFileSync(
      join(fixtureDir, 'package.json'),
      '{ "name": "orca-cli-removal-fixture", "main": "main.js" }'
    )
    writeFileSync(
      join(fixtureDir, 'main.js'),
      buildFixtureMain(join(fixtureDir, 'runtime-environments.cjs'), join(root, 'fixture.log'))
    )

    const { ELECTRON_RUN_AS_NODE: _runAsNode, ...env } = process.env
    const electronArgs = [fixtureDir, `--user-data-dir=${userDataPath}`]
    const { executable, args } = resolveElectronProbeLaunch({
      electronBinary,
      electronArgs,
      platform: process.platform,
      display: env.DISPLAY
    })
    child = spawn(executable, args, {
      env: { ...env, ORCA_BACKGROUND_LAUNCH: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    // The app connects on its own at startup, exactly as it does for a stored environment.
    await waitFor(
      () => server.openClientCount() >= 1,
      60_000,
      () =>
        `the app to connect (connections=${server.connectionCount()} open=${server.openClientCount()} methods=${server.requests.map((request) => request.method).join(',')} stderr=${stderr} fixture=${readFixtureLog(root)})`
    )
    const connectionsWhileStored = server.connectionCount()

    // What `orca environment rm` does, from a process the app knows nothing about.
    removeEnvironment(userDataPath, environment.id)

    await waitFor(
      () => server.openClientCount() === 0,
      REMOTE_RUNTIME_SOCKET_PING_INTERVAL_MS * 3,
      () => `the removed environment to lose its socket (open=${server.openClientCount()})`
    )
    await delay(REMOTE_RUNTIME_SOCKET_PING_INTERVAL_MS + 2_000)
    expect(server.openClientCount()).toBe(0)
    expect(server.connectionCount()).toBe(connectionsWhileStored)
  }, 180_000)
})

import { access, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { DaemonEndpointIdentity } from './daemon-hello-protocol'
import type { ProcessResult, ProcessSpec } from '../../shared/child-process/process-spec'

const { state, runProcessMock, materializeMock, ensureWithinMock, disconnectMock } = vi.hoisted(
  () => {
    const state: {
      root: string
      packaged: boolean
      identity: DaemonEndpointIdentity | null
    } = {
      root: '',
      packaged: true,
      identity: null
    }
    return {
      state,
      runProcessMock: vi.fn<(spec: ProcessSpec) => Promise<ProcessResult>>(),
      materializeMock: vi.fn(),
      ensureWithinMock: vi.fn(),
      disconnectMock: vi.fn()
    }
  }
)
vi.mock('../../shared/child-process/run-process', () => ({ runProcess: runProcessMock }))
vi.mock('../../shared/app-environment', () => ({
  hasAppEnvironment: () => true,
  getAppEnvironment: () => ({
    getAppPath: () => '/Applications/Orca.app/Contents/Resources/app.asar',
    getPath: () => state.root,
    getVersion: () => '1.2.3',
    isPackaged: () => state.packaged
  })
}))
vi.mock('./macos-daemon-bundle', () => ({ materializeMacDaemonBundle: materializeMock }))
vi.mock('./client', () => ({
  DaemonClient: class {
    ensureConnectedWithin = ensureWithinMock
    ensureConnected = vi.fn(async () => {})
    disconnect = disconnectMock
    getDaemonIdentity(): DaemonEndpointIdentity | null {
      return state.identity
    }
  }
}))

import {
  launchMacDaemonFromStableBundle,
  MacDaemonStableLaunchUnavailableError
} from './macos-daemon-launchd'
import type { DaemonChildSpawnOptions } from './daemon-launched-child-spawn'

let options: DaemonChildSpawnOptions
const roomyDeadline = (): number => Date.now() + 60_000

/** Lets a readiness timeout elapse without waiting for it in real time. */
function elapseOnEachConnectAttempt(error: Error, stepMs = 6_000): () => number {
  const realNow = Date.now()
  let elapsedMs = 0
  vi.spyOn(Date, 'now').mockImplementation(() => realNow + elapsedMs)
  ensureWithinMock.mockImplementation(async () => {
    elapsedMs += stepMs
    throw error
  })
  return () => elapsedMs
}
let job: unknown
let jobMode: number
const nativePlatform = process.platform
const originalGetuid = Object.getOwnPropertyDescriptor(process, 'getuid')
const originalGetSystemVersion = Object.getOwnPropertyDescriptor(process, 'getSystemVersion')
const helperContents = (): string =>
  join(state.root, 'runtime', 'Orca Terminal Host.app', 'Contents')
const helperExec = (): string => join(helperContents(), 'MacOS', 'orca-terminal-host')
const helperEntry = (): string =>
  join(helperContents(), 'Resources', 'daemon', 'out', 'main', 'daemon-entry.js')

function stubSystemVersion(version: string): void {
  Object.defineProperty(process, 'getSystemVersion', { configurable: true, value: () => version })
}

beforeEach(async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
  Object.defineProperty(process, 'getuid', { configurable: true, value: () => 501 })
  stubSystemVersion('15.4.1')
  state.root = await mkdtemp(join(tmpdir(), 'orca-mac-launch-job-'))
  state.packaged = true
  state.identity = { pid: 12345, startedAtMs: 1000, launchNonce: 'owned-launch' }
  options = {
    entryPath: '/Applications/Orca.app/Contents/Resources/daemon-entry.js',
    forkEntryPath: '/Applications/Orca.app/Contents/Resources/daemon-entry.js',
    userDataPath: state.root,
    socketPath: join(state.root, 'daemon.sock'),
    tokenPath: join(state.root, 'daemon.token'),
    pidPath: join(state.root, 'daemon.pid'),
    launchNonce: 'owned-launch',
    macosLoginSessionWatch: true
  }
  await mkdir(join(state.root, 'runtime'))
  materializeMock.mockReset().mockResolvedValue({
    directory: join(state.root, 'runtime'),
    bundlePath: join(state.root, 'runtime', 'Orca Terminal Host.app'),
    execPath: helperExec(),
    entryPath: helperEntry()
  })
  ensureWithinMock.mockReset().mockResolvedValue(undefined)
  disconnectMock.mockReset()
  runProcessMock.mockReset().mockImplementation(async (spec) => {
    if (spec.program === '/usr/bin/plutil') {
      const path = spec.args?.at(-1)
      if (!path) {
        throw new Error('No job path')
      }
      job = JSON.parse(await readFile(path, 'utf8'))
      jobMode = (await stat(path)).mode & 0o777
    }
    return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false }
  })
})

afterEach(async () => {
  vi.restoreAllMocks()
  if (originalGetuid) {
    Object.defineProperty(process, 'getuid', originalGetuid)
  } else {
    Reflect.deleteProperty(process, 'getuid')
  }
  if (originalGetSystemVersion) {
    Object.defineProperty(process, 'getSystemVersion', originalGetSystemVersion)
  } else {
    Reflect.deleteProperty(process, 'getSystemVersion')
  }
  vi.unstubAllEnvs()
  await rm(state.root, { recursive: true, force: true })
})

it('launches the copied helper on plain Node and leaves no inherited credentials on disk', async () => {
  vi.stubEnv('ORCA_TEST_SECRET', 'test-value')
  vi.stubEnv('NODE_CHANNEL_FD', '3')
  vi.stubEnv('ELECTRON_RUN_AS_NODE', '1')
  const handle = await launchMacDaemonFromStableBundle(options, roomyDeadline())
  if (nativePlatform !== 'win32') {
    expect(jobMode).toBe(0o600)
  }
  expect(job).toMatchObject({
    Label: 'com.stablyai.orca.terminal.owned-launch',
    KeepAlive: false,
    // Local Network access for a plist-launched job resolves through its associated app.
    AssociatedBundleIdentifiers: ['com.stablyai.orca'],
    EnvironmentVariables: { ORCA_TEST_SECRET: 'test-value' }
  })
  expect(JSON.stringify(job)).not.toContain('NODE_CHANNEL_FD')
  // Plain Node ignores Electron's Node-mode switch, so the job never carries it.
  expect(job).not.toHaveProperty('EnvironmentVariables.ELECTRON_RUN_AS_NODE')
  const args =
    job &&
    typeof job === 'object' &&
    'ProgramArguments' in job &&
    Array.isArray(job.ProgramArguments)
      ? job.ProgramArguments.map(String)
      : []
  expect(args.slice(0, 4)).toEqual([helperExec(), helperEntry(), '--socket', options.socketPath])
  // The replacement preflight compares the installed entry, never the private copy's.
  expect(args[args.indexOf('--entry-path') + 1]).toBe(options.entryPath)
  expect(args[args.indexOf('--spawner-exec-path') + 1]).toBe(helperExec())
  await expect(access(join(state.root, 'runtime', 'launch.plist'))).rejects.toThrow()
  expect(handle?.releaseAdoptionLease).toBeTypeOf('function')
  await handle?.shutdown()
  expect(runProcessMock).toHaveBeenCalledWith(
    expect.objectContaining({
      program: '/bin/launchctl',
      args: ['bootout', `gui/${process.getuid?.()}/com.stablyai.orca.terminal.owned-launch`]
    })
  )
})

it.each(['13.4.1', '12.7.6'])(
  'keeps macOS %s below the helper floor on the fork without copying',
  async (version) => {
    stubSystemVersion(version)
    await expect(launchMacDaemonFromStableBundle(options, roomyDeadline())).resolves.toBeNull()
    expect(materializeMock).not.toHaveBeenCalled()
    expect(runProcessMock).not.toHaveBeenCalled()
  }
)

it('runs the helper from the floor itself', async () => {
  stubSystemVersion('13.5')
  await expect(launchMacDaemonFromStableBundle(options, roomyDeadline())).resolves.not.toBeNull()
  expect(materializeMock).toHaveBeenCalledOnce()
})

const ok = { code: 0, signal: null, stdout: '', stderr: '', timedOut: false }

function routeLaunchctl(handlers: { bootstrap?: ProcessResult; print?: ProcessResult }): void {
  const plutil = runProcessMock.getMockImplementation()
  runProcessMock.mockImplementation(async (spec) => {
    if (spec.program === '/bin/launchctl' && spec.args?.[0] === 'bootstrap') {
      return handlers.bootstrap ?? ok
    }
    if (spec.program === '/bin/launchctl' && spec.args?.[0] === 'print') {
      return handlers.print ?? ok
    }
    if (spec.program === '/usr/sbin/lsof') {
      return { ...ok, code: 1 }
    }
    return (await plutil?.(spec)) ?? ok
  })
}

async function launchFailure(deadlineMs = roomyDeadline()): Promise<unknown> {
  return launchMacDaemonFromStableBundle(options, deadlineMs).then(
    () => null,
    (error: unknown) => error
  )
}

const notRunning = { ...ok, stdout: 'gui/501/x = {\n\tstate = not running\n}\n' }
const running = { ...ok, stdout: 'gui/501/x = {\n\tstate = running\n}\n' }
const missing = {
  ...ok,
  code: 113,
  stderr: 'Could not find service "x" in domain for user gui: 501'
}

it('rejects a foreign endpoint and stops only the job it created', async () => {
  state.identity = { pid: 55555, startedAtMs: 2000, launchNonce: 'another-launch' }
  const error = await launchFailure()
  expect(error).toBeInstanceOf(MacDaemonStableLaunchUnavailableError)
  expect(error).toHaveProperty('message', 'Another daemon owns the terminal endpoint')
  await expect(access(options.pidPath)).rejects.toThrow()
  expect(disconnectMock).toHaveBeenCalled()
  expect(runProcessMock).toHaveBeenCalledWith(
    expect.objectContaining({ args: ['bootout', expect.stringContaining('owned-launch')] })
  )
})

it('preserves copied code after an uncertain bootstrap while removing the private job file', async () => {
  runProcessMock
    .mockResolvedValueOnce({ code: 0, signal: null, stdout: '', stderr: '', timedOut: false })
    .mockResolvedValueOnce({
      code: null,
      signal: 'SIGTERM',
      stdout: '',
      stderr: '',
      timedOut: true
    })
  await expect(launchMacDaemonFromStableBundle(options, roomyDeadline())).rejects.toThrow(
    'start the macOS terminal service'
  )
  await expect(access(join(state.root, 'runtime'))).resolves.toBeUndefined()
  await expect(access(join(state.root, 'runtime', 'launch.plist'))).rejects.toThrow()
  expect(ensureWithinMock).not.toHaveBeenCalled()
})

it('retries a connection refusal while retaining the same launch attempt', async () => {
  ensureWithinMock.mockRejectedValueOnce(new Error('ECONNREFUSED'))
  const handle = await launchMacDaemonFromStableBundle(options, roomyDeadline())
  expect(handle).not.toBeNull()
  expect(ensureWithinMock).toHaveBeenCalledTimes(2)
  expect(materializeMock).toHaveBeenCalledTimes(1)
  expect(
    runProcessMock.mock.calls.filter(([spec]) => spec.args?.includes('bootstrap'))
  ).toHaveLength(1)
})

it('does not submit a job whose own readiness wait would overrun the deadline', async () => {
  const error = await launchFailure(Date.now() + 19_000)
  expect(error).toBeInstanceOf(MacDaemonStableLaunchUnavailableError)
  expect(error).toHaveProperty('cause.message', expect.stringContaining('deadline expired'))
  expect(runProcessMock.mock.calls.some(([spec]) => spec.args?.includes('bootstrap'))).toBe(false)
  expect(materializeMock.mock.calls[0]?.[2]).toHaveProperty('aborted', true)
  await expect(access(join(state.root, 'runtime'))).rejects.toThrow()
})

it('names the deadline when it cut the runtime copy short', async () => {
  materializeMock.mockRejectedValueOnce(new Error('Could not copy the macOS terminal runtime'))
  const error = await launchFailure(Date.now() + 19_000)
  expect(error).toBeInstanceOf(MacDaemonStableLaunchUnavailableError)
  expect(error).toHaveProperty('message', 'The macOS terminal service startup deadline expired')
  expect(runProcessMock).not.toHaveBeenCalled()
})

it('shares one preparation deadline across the copy and the plist conversion', async () => {
  await launchMacDaemonFromStableBundle(options, Date.now() + 25_000)
  const [userData, label, signal] = materializeMock.mock.calls[0] ?? []
  expect([userData, label]).toEqual([state.root, 'com.stablyai.orca.terminal.owned-launch'])
  expect(signal).toHaveProperty('aborted', false)
  const plutil = runProcessMock.mock.calls.find(([spec]) => spec.program === '/usr/bin/plutil')
  expect(plutil?.[0].signal).toBe(signal)
  // Bootstrap itself is never aborted: a killed launchctl leaves the job's fate unknown.
  const bootstrap = runProcessMock.mock.calls.find(([spec]) => spec.args?.includes('bootstrap'))
  expect(bootstrap?.[0]).not.toHaveProperty('signal')
})

it('removes a private runtime when plist preparation fails before bootstrap', async () => {
  runProcessMock.mockResolvedValue({
    code: 1,
    signal: null,
    stdout: '',
    stderr: '',
    timedOut: false
  })
  const error = await launchFailure()
  expect(error).toBeInstanceOf(MacDaemonStableLaunchUnavailableError)
  expect(error).toHaveProperty('cause.message', expect.stringContaining('prepare the macOS'))
  await expect(access(join(state.root, 'runtime'))).rejects.toThrow()
  expect(runProcessMock.mock.calls.some(([spec]) => spec.args?.includes('bootstrap'))).toBe(false)
})

it('lets the fork launcher run when the runtime copy cannot be prepared', async () => {
  materializeMock.mockRejectedValueOnce(new Error('Could not copy the macOS terminal runtime'))
  expect(await launchFailure()).toBeInstanceOf(MacDaemonStableLaunchUnavailableError)
  expect(runProcessMock).not.toHaveBeenCalled()
})

it('lets the fork launcher run and retires the copy when launchd refused the job', async () => {
  routeLaunchctl({ bootstrap: { ...ok, code: 5, stderr: 'Bootstrap failed: 5' }, print: missing })
  expect(await launchFailure()).toBeInstanceOf(MacDaemonStableLaunchUnavailableError)
  expect(ensureWithinMock).not.toHaveBeenCalled()
  await vi.waitFor(() => expect(access(join(state.root, 'runtime'))).rejects.toThrow())
})

it.each([
  ['running', running],
  ['unverifiable', { ...ok, code: 1, stderr: 'Operation not permitted' }]
])('keeps a refused bootstrap fatal when the job reads %s', async (_state, print) => {
  routeLaunchctl({ bootstrap: { ...ok, code: 5 }, print })
  const error = await launchFailure()
  expect(error).not.toBeInstanceOf(MacDaemonStableLaunchUnavailableError)
  expect(error).toHaveProperty('message', 'Could not start the macOS terminal service')
  await expect(access(join(state.root, 'runtime'))).resolves.toBeUndefined()
})

it('unregisters a daemon that exited before answering and lets the fork launcher run', async () => {
  routeLaunchctl({ print: notRunning })
  elapseOnEachConnectAttempt(new Error('ECONNREFUSED'))
  const error = await launchFailure()
  expect(error).toBeInstanceOf(MacDaemonStableLaunchUnavailableError)
  expect(runProcessMock).toHaveBeenCalledWith(
    expect.objectContaining({ args: ['bootout', expect.stringContaining('owned-launch')] })
  )
})

it('hands off as soon as the job exits instead of waiting out the readiness deadline', async () => {
  routeLaunchctl({ print: notRunning })
  const elapsed = elapseOnEachConnectAttempt(new Error('ECONNREFUSED'), 200)
  const error = await launchFailure()
  expect(error).toBeInstanceOf(MacDaemonStableLaunchUnavailableError)
  expect(elapsed()).toBeLessThan(1_000)
  expect(runProcessMock).toHaveBeenCalledWith(
    expect.objectContaining({ args: ['bootout', expect.stringContaining('owned-launch')] })
  )
})

it('keeps waiting for a job that is still running', async () => {
  routeLaunchctl({ print: running })
  const elapsed = elapseOnEachConnectAttempt(new Error('ECONNREFUSED'), 200)
  const error = await launchFailure()
  expect(error).not.toBeInstanceOf(MacDaemonStableLaunchUnavailableError)
  expect(elapsed()).toBeGreaterThanOrEqual(10_000)
  expect(runProcessMock.mock.calls.some(([spec]) => spec.args?.[0] === 'bootout')).toBe(false)
})

it('never starts another daemon while a silent job is still running', async () => {
  routeLaunchctl({ print: running })
  elapseOnEachConnectAttempt(new Error('ECONNREFUSED'))
  const error = await launchFailure()
  expect(error).not.toBeInstanceOf(MacDaemonStableLaunchUnavailableError)
  expect(error).toHaveProperty('message', 'ECONNREFUSED')
  expect(runProcessMock.mock.calls.some(([spec]) => spec.args?.[0] === 'bootout')).toBe(false)
  await expect(access(join(state.root, 'runtime'))).resolves.toBeUndefined()
})

it.each(['linux', 'win32'] as const)('keeps %s on the existing launcher', async (platform) => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
  await expect(launchMacDaemonFromStableBundle(options, roomyDeadline())).resolves.toBeNull()
  expect(materializeMock).not.toHaveBeenCalled()
  expect(runProcessMock).not.toHaveBeenCalled()
})

it('keeps Node/SSH hosts and unpackaged Electron on the existing launcher', async () => {
  await expect(
    launchMacDaemonFromStableBundle({ ...options, macosLoginSessionWatch: false }, roomyDeadline())
  ).resolves.toBeNull()
  state.packaged = false
  await expect(launchMacDaemonFromStableBundle(options, roomyDeadline())).resolves.toBeNull()
  expect(materializeMock).not.toHaveBeenCalled()
})

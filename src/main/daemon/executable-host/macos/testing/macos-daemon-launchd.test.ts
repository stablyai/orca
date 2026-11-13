import { access, mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as TimerPromises from 'node:timers/promises'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { DaemonEndpointIdentity } from '../../../protocol/daemon-hello-protocol'
import type { ProcessResult, ProcessSpec } from '@orca/process-host/process-spec'

const { state, runProcessMock, materializeMock, ensureWithinMock, disconnectMock, recoverMock } =
  vi.hoisted(() => {
    const state: { root: string; packaged: boolean; identity: DaemonEndpointIdentity | null } = {
      root: '',
      packaged: true,
      identity: null
    }
    return {
      state,
      runProcessMock: vi.fn<(spec: ProcessSpec) => Promise<ProcessResult>>(),
      materializeMock: vi.fn(),
      ensureWithinMock: vi.fn(),
      disconnectMock: vi.fn(),
      recoverMock: vi.fn<() => Promise<boolean>>()
    }
  })
const retirementClock = vi.hoisted<{ now: number; enabled: boolean; waits: number[] }>(() => ({
  now: 0,
  enabled: false,
  waits: []
}))
vi.mock('node:timers/promises', async (importOriginal) => {
  const timers = await importOriginal<typeof TimerPromises>()
  return {
    ...timers,
    setTimeout: (...args: Parameters<typeof timers.setTimeout>) => {
      if (!retirementClock.enabled) {
        return timers.setTimeout(...args)
      }
      const [ms = 1, value] = args
      retirementClock.now += ms
      retirementClock.waits.push(ms)
      return Promise.resolve(value)
    }
  }
})
vi.mock('@orca/process-host', () => ({ runProcess: runProcessMock }))
vi.mock('../../../../../shared/app-environment', () => ({
  hasAppEnvironment: () => true,
  getAppEnvironment: () => ({
    getAppPath: () => '/Applications/Orca.app/Contents/Resources/app.asar',
    getPath: () => state.root,
    getVersion: () => '1.2.3',
    isPackaged: () => state.packaged
  })
}))
vi.mock('../macos-daemon-bundle', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  materializeMacDaemonBundle: materializeMock
}))
vi.mock('../macos-retired-daemon-recovery', () => ({ recoverRetiredMacDaemonJob: recoverMock }))
vi.mock('../../../transport/client/daemon-client', () => ({
  DaemonClient: class {
    ensureConnectedWithin = ensureWithinMock
    ensureConnected = vi.fn(async () => {})
    disconnect = disconnectMock
    getDaemonIdentity(): DaemonEndpointIdentity | null {
      return state.identity
    }
  }
}))

import { launchMacDaemonFromStableBundle } from '../macos-daemon-launchd'
import { macDaemonJobLabel } from '../macos-daemon-job-label'
import type { DaemonChildSpawnOptions } from '../../../launch/daemon-launched-child-spawn'
import { PROTOCOL_VERSION } from '../../../protocol/daemon-protocol-version'

const ok: ProcessResult = { code: 0, signal: null, stdout: '', stderr: '', timedOut: false }
const running = { ...ok, stdout: 'gui/501/x = {\n\tstate = running\n}\n' }
const missing = {
  ...ok,
  code: 113,
  stderr: 'Could not find service "x" in domain for user gui: 501'
}
const lsofUnused = { ...ok, code: 1 }

type Launchctl = { bootstrap: ProcessResult; bootout: ProcessResult; print: ProcessResult[] }
let launchctl: Launchctl
let job: unknown
let jobMode = 0
let options: DaemonChildSpawnOptions & { runtimeDir: string }
let copyDir: string
const nativePlatform = process.platform
const originalGetuid = Object.getOwnPropertyDescriptor(process, 'getuid')
const originalGetSystemVersion = Object.getOwnPropertyDescriptor(process, 'getSystemVersion')
const roomyDeadline = (): number => Date.now() + 60_000
const helperExec = (): string => join(copyDir, 'MacOS', 'orca-terminal-host')
const helperEntry = (): string => join(copyDir, 'daemon-entry.js')
const service = (): string => `gui/501/${macDaemonJobLabel(state.root)}`
const launchctlCalls = (verb: string): ProcessSpec[] =>
  runProcessMock.mock.calls
    .map(([spec]) => spec)
    .filter((spec) => spec.program === '/bin/launchctl' && spec.args?.[0] === verb)
const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false
  )

function stubSystemVersion(version: string): void {
  Object.defineProperty(process, 'getSystemVersion', { configurable: true, value: () => version })
}

function beginRetirementClock(): number {
  const startedAt = Date.now()
  retirementClock.now = startedAt
  retirementClock.enabled = true
  vi.spyOn(Date, 'now').mockImplementation(() => retirementClock.now)
  return startedAt
}

function elapseOnEachConnectAttempt(stepMs: number): () => number {
  const startedAt = beginRetirementClock()
  ensureWithinMock.mockImplementation(async () => {
    retirementClock.now += stepMs
    throw new Error('ECONNREFUSED')
  })
  return () => retirementClock.now - startedAt
}

async function launchFailure(deadlineMs = roomyDeadline()): Promise<unknown> {
  return launchMacDaemonFromStableBundle(options, deadlineMs).then(
    (handle) => handle,
    (error: unknown) => error
  )
}

beforeEach(async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  Object.defineProperty(process, 'getuid', { configurable: true, value: () => 501 })
  stubSystemVersion('15.4.1')
  state.root = await mkdtemp(join(tmpdir(), 'orca-mac-launch-job-'))
  state.packaged = true
  state.identity = { pid: 12345, startedAtMs: 1000, launchNonce: 'owned-launch' }
  copyDir = join(state.root, 'daemon-host', 'macos', 'terminal-host-abc')
  await mkdir(copyDir, { recursive: true })
  options = {
    entryPath: '/Applications/Orca.app/Contents/Resources/daemon-entry.js',
    forkEntryPath: '/Applications/Orca.app/Contents/Resources/daemon-entry.js',
    userDataPath: state.root,
    runtimeDir: join(state.root, 'daemon'),
    socketPath: join(state.root, 'daemon.sock'),
    tokenPath: join(state.root, 'daemon.token'),
    pidPath: join(state.root, 'daemon.pid'),
    launchNonce: 'owned-launch',
    macosLoginSessionWatch: true
  }
  materializeMock
    .mockReset()
    .mockResolvedValue({ directory: copyDir, execPath: helperExec(), entryPath: helperEntry() })
  ensureWithinMock.mockReset().mockResolvedValue(undefined)
  disconnectMock.mockReset()
  recoverMock.mockReset().mockResolvedValue(false)
  launchctl = { bootstrap: ok, bootout: ok, print: [missing] }
  job = undefined
  runProcessMock.mockReset().mockImplementation(async (spec) => {
    const path = spec.args?.at(-1) ?? ''
    if (spec.program === '/usr/bin/plutil') {
      job = JSON.parse(await readFile(path, 'utf8'))
      jobMode = (await stat(path)).mode & 0o777
      return ok
    }
    if (spec.program === '/usr/sbin/lsof') {
      return lsofUnused
    }
    if (spec.program === '/bin/launchctl') {
      const verb = spec.args?.[0]
      if (verb === 'print') {
        return (
          (launchctl.print.length > 1 ? launchctl.print.shift() : launchctl.print[0]) ?? missing
        )
      }
      if (verb === 'bootout' && launchctl.bootout.code === 0) {
        launchctl.print = [missing]
      }
      return verb === 'bootstrap' ? launchctl.bootstrap : launchctl.bootout
    }
    return ok
  })
})

afterEach(async () => {
  retirementClock.enabled = false
  retirementClock.waits = []
  vi.restoreAllMocks()
  for (const [key, descriptor] of [
    ['getuid', originalGetuid],
    ['getSystemVersion', originalGetSystemVersion]
  ] as const) {
    if (descriptor) {
      Object.defineProperty(process, key, descriptor)
    } else {
      Reflect.deleteProperty(process, key)
    }
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
    Label: macDaemonJobLabel(state.root),
    KeepAlive: false,
    AssociatedBundleIdentifiers: ['com.stablyai.orca'],
    MaterializeDatalessFiles: true,
    EnvironmentVariables: { ORCA_TEST_SECRET: 'test-value' }
  })
  expect(JSON.stringify(job)).not.toContain('NODE_CHANNEL_FD')
  expect(job).not.toHaveProperty('EnvironmentVariables.ELECTRON_RUN_AS_NODE')
  const args =
    job &&
    typeof job === 'object' &&
    'ProgramArguments' in job &&
    Array.isArray(job.ProgramArguments)
      ? job.ProgramArguments.map(String)
      : []
  expect(args.slice(0, 5)).toEqual([
    helperExec(),
    '--max-semi-space-size=4',
    helperEntry(),
    '--socket',
    options.socketPath
  ])
  // Replacement preflight compares the installed entry, not the private helper copy.
  expect(args[args.indexOf('--entry-path') + 1]).toBe(options.entryPath)
  expect(args[args.indexOf('--spawner-exec-path') + 1]).toBe(helperExec())
  expect(await readdir(copyDir)).toEqual([])
  expect(handle?.releaseAdoptionLease).toBeTypeOf('function')
  await handle?.shutdown()
  expect(launchctlCalls('bootout').map((spec) => spec.args?.[1])).toEqual([service()])
  expect(await exists(copyDir)).toBe(true)
})

it.each([
  ['running', running],
  ['unverifiable', { ...ok, code: 1, stderr: 'Operation not permitted' }]
])('never starts beside an earlier job that reads %s', async (_state, print) => {
  launchctl.print = [print]
  // Keep retirement inside its budget so bootstrap and readiness still fit.
  const error = await launchFailure(Date.now() + 20_000)
  expect(error).toBeInstanceOf(Error)
  expect(launchctlCalls('bootstrap')).toHaveLength(0)
  expect(launchctlCalls('bootout')).toHaveLength(0)
  expect(recoverMock).toHaveBeenCalledExactlyOnceWith(
    state.root,
    options.runtimeDir,
    PROTOCOL_VERSION
  )
})

it.each([
  ['declined', async () => false],
  [
    'failed',
    async () => {
      throw new Error('descendants are unverifiable')
    }
  ]
])('keeps a running job whose recovery %s and never bootstraps beside it', async (_, impl) => {
  launchctl.print = [running]
  recoverMock.mockImplementation(impl)
  const error = await launchFailure(Date.now() + 20_000)
  expect(error).toHaveProperty(
    'message',
    expect.stringContaining('from an earlier launch is still registered')
  )
  expect(launchctlCalls('bootstrap')).toHaveLength(0)
  expect(launchctlCalls('bootout')).toHaveLength(0)
})

it('stays fatal and keeps the copy after an uncertain bootstrap, removing the job file', async () => {
  launchctl.bootstrap = { ...ok, code: null, signal: 'SIGTERM', timedOut: true }
  const error = await launchFailure()
  expect(error).toHaveProperty('message', 'Could not start the macOS terminal service')
  expect(await readdir(copyDir)).toEqual([])
  expect(await exists(copyDir)).toBe(true)
  expect(ensureWithinMock).not.toHaveBeenCalled()
})

it.each([
  ['running', running],
  ['unverifiable', { ...ok, code: 1, stderr: 'Operation not permitted' }]
])('keeps a refused bootstrap fatal when the job reads %s', async (_state, print) => {
  launchctl.bootstrap = { ...ok, code: 5 }
  launchctl.print = [missing, print]
  const error = await launchFailure()
  expect(error).toHaveProperty('message', 'launchd refused the terminal service')
  expect(await exists(copyDir)).toBe(true)
})

it('waits out a silent job that is still running and never forks beside it', async () => {
  launchctl.print = [missing, running]
  const elapsed = elapseOnEachConnectAttempt(2_000)
  const error = await launchFailure()
  expect(error).toHaveProperty('message', 'ECONNREFUSED')
  expect(elapsed()).toBeGreaterThanOrEqual(10_000)
  expect(launchctlCalls('bootout')).toHaveLength(0)
  expect(await exists(copyDir)).toBe(true)
})

it('reports a failure too late for the fork to fit the startup gate instead of forking', async () => {
  materializeMock.mockImplementation(async () => {
    vi.spyOn(Date, 'now').mockReturnValue(deadline + 1)
    throw new Error('Could not copy the macOS terminal host')
  })
  const deadline = Date.now() + 25_000
  const error = await launchFailure(deadline)
  expect(error).toHaveProperty('message', 'Could not copy the macOS terminal host')
})

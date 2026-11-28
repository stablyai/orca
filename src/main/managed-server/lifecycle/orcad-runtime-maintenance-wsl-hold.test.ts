import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcadRemoteContext } from '../install/orcad-remote-context'

const mocks = vi.hoisted(() => ({
  deployOrcad: vi.fn(),
  execCommand: vi.fn(),
  spawnProcess: vi.fn(),
  listConfirmedRunningWslDistros: vi.fn(),
  readWslDistroRunningState: vi.fn()
}))

vi.mock('@orca/process-host', () => ({ spawnProcess: mocks.spawnProcess }))
vi.mock('../../ssh/remote-exec/remote-exec-command', () => ({ execCommand: mocks.execCommand }))
vi.mock('../../wsl/discovery/wsl-background-distro-gate', () => ({
  listConfirmedRunningWslDistros: mocks.listConfirmedRunningWslDistros,
  readWslDistroRunningState: mocks.readWslDistroRunningState
}))
// Unfenced probe output keeps this test independent of the fence's nonce markers.
vi.mock('../../../shared/shell/launch/posix-stdout-fence', () => ({
  buildPosixStdoutFence: (command: string) => ({ command, readStdout: (out: string) => out })
}))
vi.mock('../install/orcad-remote-deploy', () => ({ deployOrcad: mocks.deployOrcad }))
vi.mock('../../../shared/app-lifecycle/app-environment', () => ({
  getAppEnvironment: () => ({ getVersion: () => '1.0.0' })
}))
vi.mock('../../../shared/remote-runtime/host-catalog/runtime-environments', () => ({
  redactRuntimeEnvironment: (environment: unknown) => environment
}))
vi.mock('../../orcad/artifact-slots/orcad-artifact-materializer', () => ({
  materializeOrcadArtifact: vi.fn()
}))
vi.mock('./orcad-already-active-wake', () => ({ wakeAlreadyActiveOrcad: async () => false }))
vi.mock('./orcad-managed-update-deferrals', () => ({
  clearManagedOrcadUpdateDeferral: vi.fn(),
  recordManagedOrcadUpdateDeferral: vi.fn()
}))
vi.mock('./orcad-managed-runtime-context', () => ({
  isForceableOrcadDeferral: () => false,
  managedOrcadSlot: () => ({}),
  probeManagedOrcadReadiness: async () => ({ ready: true }),
  resolveLinkedOrcadContext: vi.fn()
}))
vi.mock('./orcad-managed-version-gc', () => ({
  pruneManagedOrcadVersions: vi.fn(),
  pruneSupersededOrcadCandidates: vi.fn()
}))
vi.mock('./orcad-managed-update-failure-memory', () => ({
  clearOrcadUpdateFailedThisLaunch: vi.fn()
}))
vi.mock('./orcad-terminal-census-client', () => ({ collectManagedTerminalCensus: vi.fn() }))
vi.mock('../activation/orcad-fenced-stop', () => ({
  updateTerminalCounts: () => ({ countFirst: async () => ({}) })
}))
vi.mock('./orcad-maintenance-pairing-refresh', () => ({
  refreshMaintainedOrcadPairing: async () => ({ id: 'env-1' })
}))
vi.mock('./orcad-managed-lifecycle', () => ({
  withManagedOrcadLifecycle: vi.fn(),
  followLaunchedServerPort: vi.fn()
}))

import { runManagedOrcadUpdate } from './orcad-runtime-maintenance'

const WSL_PROBE =
  '5.15.0-microsoft-standard-WSL2\n0d9a2c84-3a1f-4f0e-9b7e-2c5d6e7f8a9b\npid:[4026531836]\n'

// Release is stdin EOF; the real hold script exits on it.
function fakeHoldChild() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn()
  })
  child.stdin.on('finish', () => {
    child.emit('exit', 0, null)
    child.emit('close', 0, null)
  })
  child.stdin.resume()
  setImmediate(() => child.stdout.write('ORCA_WSL_SSH_UPGRADE_READY\n'))
  return child
}

type TargetOverrides = { jumpHost?: string; proxyCommand?: string }

function contextFor(host: string, overrides: TargetOverrides): OrcadRemoteContext {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: runManagedOrcadUpdate reads only these fields once its collaborators are mocked.
  return {
    activationRecord: {},
    serverTarget: {},
    connection: {},
    host: { os: 'linux' },
    remoteHome: '/home/u',
    target: { id: 't1', label: 'WSL', host, port: 22, username: 'u', ...overrides },
    userDataDir: '/home/u/.orca'
  } as unknown as OrcadRemoteContext
}

function runUpdate(host: string, overrides: TargetOverrides = {}, signal?: AbortSignal) {
  const managed = { environment: { id: 'env-1' }, deployment: { remotePort: 1 } }
  return runManagedOrcadUpdate(
    '/tmp/user-data',
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only environment.id and deployment.remotePort are read.
    managed as unknown as Parameters<typeof runManagedOrcadUpdate>[1],
    contextFor(host, overrides),
    { localOrcadDir: '/tmp/orcad', signal }
  )
}

describe('runManagedOrcadUpdate WSL keep-alive', () => {
  const platform = process.platform
  let child: ReturnType<typeof fakeHoldChild> | undefined

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    child = undefined
    mocks.execCommand.mockResolvedValue(WSL_PROBE)
    mocks.listConfirmedRunningWslDistros.mockResolvedValue(['Ubuntu'])
    mocks.readWslDistroRunningState.mockResolvedValue('running')
    mocks.spawnProcess.mockImplementation(() => (child = fakeHoldChild()))
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: platform })
    vi.clearAllMocks()
  })

  it('holds a loopback WSL distro for the deploy and releases it afterwards', async () => {
    let heldDuringDeploy = false
    mocks.deployOrcad.mockImplementation(async () => {
      heldDuringDeploy = child !== undefined && !child.stdin.writableEnded
      return { outcome: 'already-active', fullVersion: 'v2' }
    })

    await expect(runUpdate('localhost')).resolves.toMatchObject({ outcome: 'already-current' })

    expect(mocks.spawnProcess).toHaveBeenCalledTimes(1)
    expect(heldDuringDeploy).toBe(true)
    expect(child?.stdin.writableEnded).toBe(true)
  })

  it('releases the hold when the deploy fails', async () => {
    mocks.deployOrcad.mockRejectedValue(new Error('connection closed'))

    await expect(runUpdate('127.0.0.1')).rejects.toThrow('connection closed')

    expect(child?.stdin.writableEnded).toBe(true)
  })

  it('does not probe or hold WSL for a non-loopback host', async () => {
    mocks.deployOrcad.mockResolvedValue({ outcome: 'already-active', fullVersion: 'v2' })

    await expect(runUpdate('build-box.example.com')).resolves.toMatchObject({
      outcome: 'already-current'
    })

    expect(mocks.execCommand).not.toHaveBeenCalled()
    expect(mocks.spawnProcess).not.toHaveBeenCalled()
  })

  it.each([
    ['a non-Windows desktop', 'linux', {}],
    ['a jump host', 'win32', { jumpHost: 'bastion' }],
    ['a proxy command', 'win32', { proxyCommand: 'nc %h %p' }]
  ] as const)('does not probe or hold WSL through %s', async (_name, os, overrides) => {
    Object.defineProperty(process, 'platform', { value: os })
    mocks.deployOrcad.mockResolvedValue({ outcome: 'already-active', fullVersion: 'v2' })

    await expect(runUpdate('localhost', overrides)).resolves.toMatchObject({
      outcome: 'already-current'
    })

    expect(mocks.execCommand).not.toHaveBeenCalled()
    expect(mocks.spawnProcess).not.toHaveBeenCalled()
  })

  it('still updates when the hold cannot be started', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.spawnProcess.mockImplementation(() => {
      throw new Error('spawn EPERM')
    })
    mocks.deployOrcad.mockResolvedValue({ outcome: 'already-active', fullVersion: 'v2' })

    await expect(runUpdate('localhost')).resolves.toMatchObject({ outcome: 'already-current' })

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('could not keep WSL'),
      expect.anything()
    )
    warn.mockRestore()
  })

  it('fails the update when the user cancels while the hold starts', async () => {
    const cancel = new AbortController()
    mocks.execCommand.mockImplementation(async () => {
      cancel.abort(new Error('canceled'))
      throw new Error('aborted')
    })

    await expect(runUpdate('localhost', {}, cancel.signal)).rejects.toThrow('canceled')

    expect(mocks.deployOrcad).not.toHaveBeenCalled()
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as MacosTccLoginShell from './macos-tcc-login-shell'

const {
  existsSyncMock,
  statSyncMock,
  accessSyncMock,
  mkdirSyncMock,
  writeFileSyncMock,
  spawnMock,
  prepareMacosTccLoginShellMock,
  resolveAgentForegroundProcessMock,
  readWindowsPtyJobProcessIdsMock,
  killWithDescendantSweepMock,
  isWslAvailableAsyncMock,
  wslUncDirectoryExistsMock,
  createShellPromptReadinessProbeMock
} = vi.hoisted(() => ({
  existsSyncMock: vi.fn(),
  statSyncMock: vi.fn(),
  accessSyncMock: vi.fn(),
  mkdirSyncMock: vi.fn(),
  writeFileSyncMock: vi.fn(),
  spawnMock: vi.fn(),
  prepareMacosTccLoginShellMock: vi.fn(),
  resolveAgentForegroundProcessMock: vi.fn(),
  readWindowsPtyJobProcessIdsMock: vi.fn(),
  killWithDescendantSweepMock: vi.fn(),
  isWslAvailableAsyncMock: vi.fn(),
  wslUncDirectoryExistsMock: vi.fn(),
  createShellPromptReadinessProbeMock: vi.fn()
}))

vi.mock('fs', () => ({
  existsSync: existsSyncMock,
  statSync: statSyncMock,
  accessSync: accessSyncMock,
  mkdirSync: mkdirSyncMock,
  writeFileSync: writeFileSyncMock,
  chmodSync: vi.fn(),
  renameSync: vi.fn(),
  rmSync: vi.fn(),
  constants: { X_OK: 1 }
}))

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/orca-user-data') }
}))

vi.mock('node-pty', () => ({ spawn: spawnMock }))

vi.mock('./macos-tcc-login-shell', async (importOriginal) => ({
  ...(await importOriginal<typeof MacosTccLoginShell>()),
  prepareMacosTccLoginShell: prepareMacosTccLoginShellMock
}))

vi.mock('../pty-descendant-termination', () => ({
  killWithDescendantSweep: killWithDescendantSweepMock
}))

const WINDOWS_POWERSHELL_ABS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
vi.mock('./windows-powershell-executable', () => ({
  resolveWindowsPowerShellExecutablePath: () => WINDOWS_POWERSHELL_ABS,
  resolveWindowsPowerShellSpawnChain: () => [WINDOWS_POWERSHELL_ABS],
  getWindowsCmdPath: () => 'C:\\Windows\\System32\\cmd.exe'
}))

vi.mock('./agent-foreground-process', () => ({
  resolveAgentForegroundProcessWithAvailability: (...args: unknown[]) =>
    resolveAgentForegroundProcessMock(...args)
}))

vi.mock('./windows-pty-job-membership', () => ({
  readWindowsPtyJobProcessIds: (...args: unknown[]) => readWindowsPtyJobProcessIdsMock(...args),
  isWindowsPtyJobReadable: () => true
}))

vi.mock('../wsl', () => ({
  parseWslPath: () => null,
  toLinuxPath: (path: string) => path,
  toWindowsWslPath: (path: string) => path,
  getDefaultWslDistro: () => 'Ubuntu',
  isWslAvailableAsync: () => isWslAvailableAsyncMock(),
  wslUncDirectoryExists: (...args: unknown[]) => wslUncDirectoryExistsMock(...args)
}))

vi.mock('../shell-prompt-readiness-probe', () => ({
  createShellPromptReadinessProbe: createShellPromptReadinessProbeMock
}))

import { LocalPtyProvider, _resetLocalPtyProviderStateForTest } from './local-pty-provider'
import { inspectPtyProviderProcessForRenderer } from './pty-process-inspection'
import {
  applyLocalPtyProviderMockDefaults,
  createLocalPtyMockProcess,
  installLocalPtyProviderEnvSandbox,
  type LocalPtyExitCallback,
  type LocalPtyMockProcess
} from './local-pty-provider-test-harness'

describe('LocalPtyProvider.ptyAbsenceVerdict', () => {
  let provider: LocalPtyProvider
  let mockProc: LocalPtyMockProcess
  let exitCb: LocalPtyExitCallback | undefined

  installLocalPtyProviderEnvSandbox()

  beforeEach(() => {
    applyLocalPtyProviderMockDefaults({
      existsSyncMock,
      statSyncMock,
      accessSyncMock,
      mkdirSyncMock,
      writeFileSyncMock,
      prepareMacosTccLoginShellMock,
      resolveAgentForegroundProcessMock,
      readWindowsPtyJobProcessIdsMock,
      killWithDescendantSweepMock,
      isWslAvailableAsyncMock,
      wslUncDirectoryExistsMock,
      createShellPromptReadinessProbeMock
    })
    exitCb = undefined
    mockProc = createLocalPtyMockProcess({
      get: () => exitCb,
      set: (cb) => {
        exitCb = cb
      }
    })
    spawnMock.mockReturnValue(mockProc)
    provider = new LocalPtyProvider()
  })

  it('answers unverifiable for an id it never owned', () => {
    // The pre-swap provider is asked about a restored daemon session: absent, but unobserved.
    expect(provider.hasPty('daemon-restored-1')).toBe(false)
    expect(provider.ptyAbsenceVerdict('daemon-restored-1')).toBe('unverifiable')
  })

  it('answers exited only after it watched the process go', async () => {
    const { id } = await provider.spawn({ cols: 80, rows: 24 })
    expect(provider.hasPty(id)).toBe(true)
    expect(provider.ptyAbsenceVerdict(id)).toBe('unverifiable')

    exitCb?.({ exitCode: 0 })

    expect(provider.hasPty(id)).toBe(false)
    expect(provider.ptyAbsenceVerdict(id)).toBe('exited')
  })

  it('answers exited for a PTY it killed on app quit', async () => {
    const { id } = await provider.spawn({ cols: 80, rows: 24 })

    provider.killAll()

    expect(provider.hasPty(id)).toBe(false)
    expect(provider.ptyAbsenceVerdict(id)).toBe('exited')
  })

  it('retires every exit record when the suite resets provider state', async () => {
    // The watched-exit table is module-global and clearPtyState deliberately does not touch
    // it, so without this the record outlives its suite and the next one starts holding a
    // death certificate for an id it never owned — the exact verdict this contract forbids.
    const leakedId = 'pane-session-leaked'
    await provider.spawn({ cols: 80, rows: 24, sessionId: leakedId })
    exitCb?.({ exitCode: 0 })
    // Asserted on the shape the renderer reads, not on the verdict string.
    await expect(inspectPtyProviderProcessForRenderer(provider, leakedId)).resolves.toMatchObject({
      processEvidence: { children: { verdict: 'exited' } }
    })

    _resetLocalPtyProviderStateForTest()

    await expect(
      inspectPtyProviderProcessForRenderer(new LocalPtyProvider(), leakedId)
    ).resolves.toMatchObject({
      unavailable: true,
      processEvidence: { children: { verdict: 'unverifiable' } }
    })
  })

  it('retires the exit record when the same id is spawned again', async () => {
    const reusedId = 'pane-session-a'
    const { id } = await provider.spawn({ cols: 80, rows: 24, sessionId: reusedId })
    expect(id).toBe(reusedId)
    exitCb?.({ exitCode: 0 })
    expect(provider.ptyAbsenceVerdict(id)).toBe('exited')

    spawnMock.mockReturnValue(mockProc)
    await provider.spawn({ cols: 80, rows: 24, sessionId: reusedId })

    expect(provider.hasPty(id)).toBe(true)
    expect(provider.ptyAbsenceVerdict(id)).toBe('unverifiable')
  })
})

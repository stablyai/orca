import { assert, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as MacosTccLoginShell from './macos-tcc-login-shell'
import type * as ForegroundProcess from './agent-foreground-process'
import type { WindowsProcessRow } from '../windows/windows-process-table'
import {
  ptyLastRecognizedForeground,
  ptyProcesses,
  ptyIncarnations
} from './local-pty-provider-state'
import { inspectionShowsShellAlone } from '../runtime/run-terminal-shell-alone'
import {
  assertCliConversationWritersExited,
  type CliWriterHost
} from '../runtime/structured-agent-cli-writers'

const {
  fullTable,
  identityTable,
  consoleMembers,
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
  wslUncDirectoryExistsAsyncMock,
  createShellPromptReadinessProbeMock
} = vi.hoisted(() => ({
  fullTable: vi.fn(),
  identityTable: vi.fn(),
  consoleMembers: vi.fn(),
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
  wslUncDirectoryExistsAsyncMock: vi.fn(),
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
  app: {
    getPath: vi.fn(() => '/tmp/orca-user-data')
  }
}))

vi.mock('node-pty', () => ({
  spawn: spawnMock
}))

vi.mock('./macos-tcc-login-shell', async (importOriginal) => ({
  ...(await importOriginal<typeof MacosTccLoginShell>()),
  prepareMacosTccLoginShell: prepareMacosTccLoginShellMock
}))

vi.mock('../pty-descendant-termination', () => ({
  killWithDescendantSweep: killWithDescendantSweepMock
}))

// The fs mock misses executable probes; pin paths here and leave Store-alias coverage to the resolver tests.
const WINDOWS_POWERSHELL_ABS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const PWSH7_ABS = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
const CMD_ABS = 'C:\\Windows\\System32\\cmd.exe'
vi.mock('./windows-powershell-executable', () => ({
  resolveWindowsPowerShellExecutablePath: (family: 'pwsh.exe' | 'powershell.exe') =>
    family === 'pwsh.exe' ? PWSH7_ABS : WINDOWS_POWERSHELL_ABS,
  resolveWindowsPowerShellSpawnChain: (family: 'pwsh.exe' | 'powershell.exe') =>
    family === 'pwsh.exe'
      ? [PWSH7_ABS, WINDOWS_POWERSHELL_ABS, CMD_ABS]
      : [WINDOWS_POWERSHELL_ABS, CMD_ABS],
  getWindowsCmdPath: () => CMD_ABS
}))

vi.mock('./agent-foreground-process', async (importOriginal) => ({
  ...(await importOriginal<typeof ForegroundProcess>()),
  resolveAgentForegroundProcessWithAvailability: (...args: unknown[]) =>
    resolveAgentForegroundProcessMock(...args)
}))

vi.mock('./windows-pty-job-membership', () => ({
  readWindowsPtyJobProcessIds: (...args: unknown[]) => readWindowsPtyJobProcessIdsMock(...args),
  isWindowsPtyJobReadable: () => true
}))

vi.mock('../windows/windows-process-table', () => ({
  readWindowsProcessTable: fullTable,
  readWindowsProcessTableFresh: fullTable,
  readWindowsProcessIdentityTable: identityTable,
  readWindowsProcessIdentityTableFresh: identityTable
}))
vi.mock('./windows-console-attached-processes', () => ({
  readWindowsConsoleAttachedProcessIds: consoleMembers
}))

vi.mock('../wsl', () => ({
  parseWslPath: (path: string) => {
    const match = path.match(/^\\\\wsl\.localhost\\([^\\]+)(.*)$/)
    if (!match) {
      return null
    }
    return {
      distro: match[1],
      linuxPath: (match[2] || '').replace(/\\/g, '/') || '/'
    }
  },
  toLinuxPath: (path: string) => path.replace(/^C:\\/i, '/mnt/c/').replace(/\\/g, '/'),
  toWindowsWslPath: (path: string, distro: string) =>
    `\\\\wsl.localhost\\${distro}${path.replace(/\//g, '\\')}`,
  getDefaultWslDistro: () => 'Ubuntu',
  isWslAvailableAsync: () => isWslAvailableAsyncMock(),
  // Fixture WSL UNC directories exist; avoid launching wsl.exe to validate them.
  wslUncDirectoryExistsAsync: (...args: unknown[]) => wslUncDirectoryExistsAsyncMock(...args)
}))

vi.mock('../shell-prompt-readiness-probe', () => ({
  createShellPromptReadinessProbe: createShellPromptReadinessProbeMock
}))

import { LocalPtyProvider } from './local-pty-provider'
import {
  applyLocalPtyProviderMockDefaults,
  createLocalPtyMockProcess,
  installLocalPtyProviderEnvSandbox,
  type LocalPtyMockProcess
} from './local-pty-provider-test-harness'

describe('LocalPtyProvider', () => {
  let provider: LocalPtyProvider
  let mockProc: LocalPtyMockProcess
  let exitCb: ((info: { exitCode: number }) => void) | undefined

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
      wslUncDirectoryExistsAsyncMock,
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

  describe('hasChildProcesses', () => {
    it('fences full inspection with the original PTY incarnation across awaits', async () => {
      const { id, incarnationId } = await provider.spawn({ cols: 80, rows: 24 })
      await expect(
        provider.inspectProcess(id, { expectedIncarnationId: 'replacement' })
      ).resolves.toMatchObject({ childProcessEvidence: 'unverifiable' })
      let resolveScan!: (resolution: { available: boolean; processName: string }) => void
      resolveAgentForegroundProcessMock.mockReturnValue(
        new Promise((resolve) => {
          resolveScan = resolve
        })
      )
      const inspection = provider.inspectProcess(id, { expectedIncarnationId: incarnationId })
      exitCb?.({ exitCode: 0 })
      resolveScan({ available: true, processName: 'zsh' })
      await expect(inspection).resolves.toMatchObject({ childProcessEvidence: 'unverifiable' })
    })

    it('returns false when foreground process matches shell', async () => {
      const { id } = await provider.spawn({ cols: 80, rows: 24 })
      expect(await provider.hasChildProcesses(id)).toBe(false)
    })

    it('returns true when foreground process differs from shell', async () => {
      mockProc.process = 'node'
      const { id } = await provider.spawn({ cols: 80, rows: 24 })
      expect(await provider.hasChildProcesses(id)).toBe(true)
    })

    it('returns false for unknown PTY ids', async () => {
      expect(await provider.hasChildProcesses('nonexistent')).toBe(false)
    })
  })

  it.each([false, true])(
    'reconciles real Windows decision evidence (static=%s)',
    async (staticName) => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      const actual = await vi.importActual<typeof ForegroundProcess>('./agent-foreground-process')
      resolveAgentForegroundProcessMock.mockImplementation(
        actual.resolveAgentForegroundProcessWithAvailability
      )
      mockProc.pid = 100
      mockProc.process = 'powershell.exe'
      Object.assign(mockProc, { processNameIsSpawnFile: staticName })
      const { id, incarnationId } = await provider.spawn({
        cols: 80,
        rows: 24,
        shellOverride: 'powershell.exe'
      })
      assert(incarnationId, 'fixture incarnation missing')
      const nativeRow = (
        pid: number,
        ppid: number,
        name: string,
        command = name
      ): WindowsProcessRow => ({ pid, ppid, name, command, creationTimeMs: pid })
      const shell = nativeRow(100, 1, 'powershell.exe')
      const orphan = nativeRow(120, 999, 'claude.exe', 'claude.exe --resume conversation')
      const daemon = nativeRow(130, 1, 'ssh-agent.exe', 'ssh-agent.exe -D')
      type EvidenceOptions = {
        age?: number
        detailed?: WindowsProcessRow[]
        identities?: WindowsProcessRow[]
        scanFailed?: boolean
        jobFailed?: boolean
        consoleFailed?: boolean
        childFailed?: boolean
      }
      const cases: [string, number | null, WindowsProcessRow[], boolean, EvidenceOptions?][] = [
        ['C1', null, [shell, daemon], true],
        ['live young anchor', 120, [shell, orphan], false],
        ['live old anchor', 120, [shell, orphan], false, { age: 40_000 }],
        ['anchor identity missing', 120, [shell, orphan], false, { detailed: [shell] }],
        ['anchor query denied', 120, [shell, nativeRow(120, 999, 'unknown.exe', '')], false],
        ['anchored scan failed', 120, [shell, orphan], false, { scanFailed: true }],
        ['job unavailable', 120, [shell, orphan], false, { jobFailed: true }],
        ['anchor absent', 120, [shell, daemon], true],
        ['anchor just exited', 120, [shell], true],
        [
          'foreign anchor',
          120,
          [shell, nativeRow(120, 999, 'ssh-agent.exe', 'ssh-agent.exe -D')],
          true
        ],
        ['attached agent', null, [shell, { ...orphan, ppid: 100 }], false],
        ['ordinary background job', null, [shell, nativeRow(130, 100, 'sleep.exe')], false],
        ['incomplete identity', null, [shell, daemon], false, { identities: [shell] }],
        ['console unavailable', null, [shell, daemon], false, { consoleFailed: true }],
        ['child read failed', null, [shell, daemon], false, { childFailed: true }],
        ['unanchored degraded complete', null, [shell, daemon], true, { scanFailed: true }],
        [
          'unanchored degraded incomplete',
          null,
          [shell, daemon],
          false,
          { scanFailed: true, identities: [shell] }
        ]
      ]
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        const seed = (pid: number | null) =>
          ptyLastRecognizedForeground.set(id, { name: 'claude', pid, at: 1000, steady: null })
        for (const [name, anchor, rows, admits, input = {}] of cases) {
          vi.setSystemTime(1000 + (input.age ?? 1000))
          seed(anchor)
          readWindowsPtyJobProcessIdsMock.mockReturnValue(
            input.jobFailed ? null : new Set(rows.map((row) => row.pid))
          )
          fullTable.mockReset().mockResolvedValue(input.detailed ?? rows)
          if (input.scanFailed) {
            fullTable.mockRejectedValue(new Error('denied'))
          }
          identityTable.mockReset().mockResolvedValue(input.identities ?? rows)
          if (input.childFailed) {
            identityTable.mockRejectedValue(new Error('denied'))
          }
          consoleMembers.mockResolvedValue(input.consoleFailed ? null : new Set([100]))
          let alone: boolean | undefined
          const host: CliWriterHost = {
            rows: () => [
              {
                paneKey: 'source',
                connectionId: null,
                worktreeId: 'workspace',
                agentType: 'claude',
                state: 'done',
                prompt: '',
                receivedAt: 1,
                stateStartedAt: 1,
                providerSession: { key: 'session_id', id: 'conversation' }
              }
            ],
            saved: () => [],
            links: () => [],
            sleeping: () => false,
            observation: () => ({
              current: () => true,
              topology: 'pane-owned',
              presence: async () => null
            }),
            terminal: () => ({ pane: { ptyId: id, incarnationId, identity: id + incarnationId } }),
            shellAlone: async () => {
              const observed = await provider.inspectProcess(id, {
                expectedIncarnationId: incarnationId,
                scanChildProcesses: true,
                ignoreDetached: true
              })
              alone = inspectionShowsShellAlone(observed)
              return alone
            }
          }
          const result = expect(assertCliConversationWritersExited(host, 'claude', 'conversation'))
          await (admits
            ? result.resolves.toBeUndefined()
            : result.rejects.toMatchObject({ refusal: { code: 'agent_session_conflict' } }))
          expect(alone, name).toBe(admits)
          expect(fullTable, name).toHaveBeenCalledTimes(1)
          expect(identityTable.mock.calls.length, name).toBe(
            input.jobFailed || rows.length === 1 ? 0 : 1
          )
        }
        fullTable.mockReset().mockResolvedValue([shell, daemon])
        identityTable.mockReset().mockResolvedValue([shell, daemon])
        consoleMembers.mockResolvedValue(new Set([100]))
        readWindowsPtyJobProcessIdsMock.mockReturnValue(new Set([100, 130]))
        for (const count of [2, 20]) {
          fullTable.mockClear()
          identityTable.mockClear()
          for (let i = 0; i < count; i++) {
            seed(null)
            expect(
              inspectionShowsShellAlone(await provider.inspectProcess(id, { ignoreDetached: true }))
            ).toBe(true)
          }
          expect(fullTable).toHaveBeenCalledTimes(count)
          expect(identityTable).toHaveBeenCalledTimes(count)
        }
        seed(null)
        fullTable.mockClear()
        expect(await provider.getForegroundProcess(id)).toBe('claude')
        await expect(
          provider.inspectProcess(id, { steadyState: true, ignoreDetached: true })
        ).resolves.toMatchObject({ foregroundProcess: 'claude' })
        expect(fullTable).not.toHaveBeenCalled()
        expect(
          inspectionShowsShellAlone(await provider.inspectProcess(id, { ignoreDetached: false }))
        ).toBe(false)
        seed(120)
        fullTable.mockResolvedValue([shell, orphan])
        identityTable.mockResolvedValue([shell, orphan])
        readWindowsPtyJobProcessIdsMock.mockReturnValue(new Set([100, 120]))
        expect(await provider.confirmForegroundProcess(id)).not.toBe('claude')
        for (const replacement of ['object', 'incarnation']) {
          const original = ptyProcesses.get(id)
          if (!original) {
            throw new Error('fixture PTY missing')
          }
          fullTable.mockImplementationOnce(async () => {
            if (replacement === 'object') {
              ptyProcesses.set(id, { ...original })
            } else {
              ptyIncarnations.set(id, 'replacement')
            }
            return [shell]
          })
          await expect(
            provider.inspectProcess(id, {
              expectedIncarnationId: incarnationId,
              ignoreDetached: true
            })
          ).resolves.toMatchObject({ childProcessEvidence: 'unverifiable' })
          ptyProcesses.set(id, original)
          ptyIncarnations.set(id, incarnationId)
        }
      } finally {
        vi.useRealTimers()
      }
    }
  )

  describe('getForegroundProcess', () => {
    it('returns the process name', async () => {
      const { id } = await provider.spawn({ cols: 80, rows: 24 })
      expect(await provider.getForegroundProcess(id)).toBe('zsh')
    })

    it('uses the spawned Windows shell when node-pty reports only the terminal name', async () => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      mockProc.process = 'xterm-256color'

      const { id } = await provider.spawn({
        cols: 80,
        rows: 24,
        shellOverride: 'powershell.exe'
      })

      expect(await provider.getForegroundProcess(id)).toBe('powershell.exe')
      expect(resolveAgentForegroundProcessMock).toHaveBeenCalledWith(
        mockProc.pid,
        'powershell.exe',
        expect.any(Object)
      )
    })

    it('returns null for unknown PTY ids', async () => {
      expect(await provider.getForegroundProcess('nonexistent')).toBeNull()
    })

    it('keeps a recognized agent across an unavailable scan without adding probes', async () => {
      resolveAgentForegroundProcessMock
        .mockResolvedValueOnce({ available: true, processName: 'claude' })
        .mockResolvedValueOnce({ available: false, processName: 'powershell.exe' })
      const { id } = await provider.spawn({ cols: 80, rows: 24 })

      await expect(provider.getForegroundProcess(id)).resolves.toBe('claude')
      await expect(provider.getForegroundProcess(id)).resolves.toBe('claude')
      expect(resolveAgentForegroundProcessMock).toHaveBeenCalledTimes(2)
    })

    it('drops a delayed scan result after the PTY exits', async () => {
      let resolveScan!: (resolution: { available: boolean; processName: string }) => void
      resolveAgentForegroundProcessMock.mockReturnValue(
        new Promise((resolve) => {
          resolveScan = resolve
        })
      )
      const { id } = await provider.spawn({ cols: 80, rows: 24 })

      const foreground = provider.getForegroundProcess(id)
      exitCb?.({ exitCode: 0 })
      resolveScan({ available: true, processName: 'droid' })

      await expect(foreground).resolves.toBeNull()
    })

    it('confirms a still-active agent from job membership without a whole-table scan', async () => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      mockProc.process = 'powershell.exe'
      resolveAgentForegroundProcessMock.mockResolvedValue({
        available: true,
        processName: 'claude'
      })
      // A descendant beyond the shell is still in the pane's job.
      readWindowsPtyJobProcessIdsMock.mockReturnValue(new Set([12345, 999]))
      const { id } = await provider.spawn({ cols: 80, rows: 24 })

      await expect(provider.getForegroundProcess(id)).resolves.toBe('claude')
      // node-pty names only the shell; job membership revalidates the agent without another full scan.
      await expect(provider.getForegroundProcess(id)).resolves.toBe('claude')
      expect(resolveAgentForegroundProcessMock).toHaveBeenCalledTimes(1)
    })

    it('stops trusting job membership once the cached agent goes stale', async () => {
      // An unanchored job superset must age out; WSL detached plumbing can otherwise pin agent identity forever.
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      mockProc.process = 'powershell.exe'
      resolveAgentForegroundProcessMock.mockResolvedValue({
        available: true,
        processName: 'claude'
      })
      readWindowsPtyJobProcessIdsMock.mockReturnValue(new Set([12345, 999]))
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        vi.setSystemTime(1_000_000)
        const { id } = await provider.spawn({ cols: 80, rows: 24 })

        await expect(provider.getForegroundProcess(id)).resolves.toBe('claude')
        await expect(provider.getForegroundProcess(id)).resolves.toBe('claude')
        expect(resolveAgentForegroundProcessMock).toHaveBeenCalledTimes(1)

        vi.setSystemTime(1_000_000 + 40_000)
        resolveAgentForegroundProcessMock.mockResolvedValue({
          available: true,
          processName: 'powershell.exe'
        })
        await expect(provider.getForegroundProcess(id)).resolves.toBe('powershell.exe')
        expect(resolveAgentForegroundProcessMock).toHaveBeenCalledTimes(2)
      } finally {
        vi.useRealTimers()
      }
    })

    it('does not refresh the agent age after a degraded revalidation scan', async () => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      mockProc.process = 'powershell.exe'
      resolveAgentForegroundProcessMock
        .mockResolvedValueOnce({ available: true, processName: 'claude' })
        .mockResolvedValueOnce({ available: false, processName: null })
        .mockResolvedValue({ available: true, processName: 'powershell.exe' })
      readWindowsPtyJobProcessIdsMock.mockReturnValue(new Set([12345, 999]))
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        vi.setSystemTime(1_000_000)
        const { id } = await provider.spawn({ cols: 80, rows: 24 })

        await expect(provider.getForegroundProcess(id)).resolves.toBe('claude')

        vi.setSystemTime(1_000_000 + 40_000)
        await expect(provider.getForegroundProcess(id)).resolves.toBe('claude')

        vi.setSystemTime(1_000_000 + 41_000)
        await expect(provider.getForegroundProcess(id)).resolves.toBe('powershell.exe')
        expect(resolveAgentForegroundProcessMock).toHaveBeenCalledTimes(3)
      } finally {
        vi.useRealTimers()
      }
    })

    it('keeps short-circuiting a live agent instead of scanning on every call', async () => {
      // Confirmation must reset age; measuring total runtime would permanently disable cheap rechecks (#9258).
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      mockProc.process = 'powershell.exe'
      resolveAgentForegroundProcessMock.mockResolvedValue({
        available: true,
        processName: 'claude'
      })
      readWindowsPtyJobProcessIdsMock.mockReturnValue(new Set([12345, 999]))
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        vi.setSystemTime(1_000_000)
        const { id } = await provider.spawn({ cols: 80, rows: 24 })

        await expect(provider.getForegroundProcess(id)).resolves.toBe('claude')
        expect(resolveAgentForegroundProcessMock).toHaveBeenCalledTimes(1)

        vi.setSystemTime(1_000_000 + 40_000)
        await expect(provider.getForegroundProcess(id)).resolves.toBe('claude')
        expect(resolveAgentForegroundProcessMock).toHaveBeenCalledTimes(2)

        vi.setSystemTime(1_000_000 + 45_000)
        await expect(provider.getForegroundProcess(id)).resolves.toBe('claude')
        await expect(provider.getForegroundProcess(id)).resolves.toBe('claude')
        expect(resolveAgentForegroundProcessMock).toHaveBeenCalledTimes(2)
      } finally {
        vi.useRealTimers()
      }
    })

    it('falls through to the scan when the job holds only the shell', async () => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      mockProc.process = 'powershell.exe'
      resolveAgentForegroundProcessMock.mockResolvedValue({
        available: true,
        processName: 'claude'
      })
      readWindowsPtyJobProcessIdsMock.mockReturnValue(new Set([12345]))
      const { id } = await provider.spawn({ cols: 80, rows: 24 })

      await expect(provider.getForegroundProcess(id)).resolves.toBe('claude')
      await expect(provider.getForegroundProcess(id)).resolves.toBe('claude')
      expect(resolveAgentForegroundProcessMock).toHaveBeenCalledTimes(2)
    })

    it('keeps the cached agent when both the console probe and process snapshot are inconclusive', async () => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      mockProc.process = 'powershell.exe'
      resolveAgentForegroundProcessMock
        .mockResolvedValueOnce({ available: true, processName: 'claude' })
        .mockResolvedValue({ available: true, processName: null })
      readWindowsPtyJobProcessIdsMock.mockReturnValue(null)
      const { id } = await provider.spawn({ cols: 80, rows: 24 })

      await expect(provider.getForegroundProcess(id)).resolves.toBe('claude')
      await expect(provider.getForegroundProcess(id)).resolves.toBe('claude')
      expect(resolveAgentForegroundProcessMock).toHaveBeenCalledTimes(2)
    })

    it('retires an anchored agent immediately when its pid leaves the job, despite a leftover', async () => {
      // A missing anchor proves exit immediately; detached leftovers cannot preserve that identity.
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: 'win32'
      })
      mockProc.process = 'powershell.exe'
      resolveAgentForegroundProcessMock
        .mockResolvedValueOnce({
          available: true,
          processName: 'claude',
          processId: 999
        })
        .mockResolvedValue({ available: true, processName: null })
      readWindowsPtyJobProcessIdsMock.mockReturnValue(new Set([12345, 999]))
      const { id } = await provider.spawn({ cols: 80, rows: 24 })

      await expect(provider.getForegroundProcess(id)).resolves.toBe('claude')
      readWindowsPtyJobProcessIdsMock.mockReturnValue(new Set([12345, 777]))
      await expect(provider.getForegroundProcess(id)).resolves.toBeNull()
      expect(resolveAgentForegroundProcessMock).toHaveBeenCalledTimes(2)
    })

    it('never expires an anchored agent the job still holds, even when scans miss it', async () => {
      // A live job anchor outranks incomplete scans and refreshes the age bound.
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: 'win32'
      })
      mockProc.process = 'powershell.exe'
      resolveAgentForegroundProcessMock
        .mockResolvedValueOnce({
          available: true,
          processName: 'claude',
          processId: 999
        })
        .mockResolvedValue({ available: true, processName: null })
      readWindowsPtyJobProcessIdsMock.mockReturnValue(new Set([12345, 999]))
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        vi.setSystemTime(1_000_000)
        const { id } = await provider.spawn({ cols: 80, rows: 24 })

        await expect(provider.getForegroundProcess(id)).resolves.toBe('claude')

        vi.setSystemTime(1_000_000 + 40_000)
        await expect(provider.getForegroundProcess(id)).resolves.toBe('claude')
        expect(resolveAgentForegroundProcessMock).toHaveBeenCalledTimes(2)

        vi.setSystemTime(1_000_000 + 45_000)
        await expect(provider.getForegroundProcess(id)).resolves.toBe('claude')
        expect(resolveAgentForegroundProcessMock).toHaveBeenCalledTimes(2)

        vi.setSystemTime(1_000_000 + 80_000)
        await expect(provider.getForegroundProcess(id)).resolves.toBe('claude')
        expect(resolveAgentForegroundProcessMock).toHaveBeenCalledTimes(3)
      } finally {
        vi.useRealTimers()
      }
    })

    it('holds a restarting agent across a degraded scan instead of reporting an exit', async () => {
      // A degraded scan during restart cannot prove exit; retain unanchored identity until a fresh scan re-anchors.
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      mockProc.process = 'powershell.exe'
      resolveAgentForegroundProcessMock
        .mockResolvedValueOnce({ available: true, processName: 'claude', processId: 999 })
        .mockResolvedValueOnce({ available: false, processName: null })
        .mockResolvedValue({ available: true, processName: 'claude', processId: 1000 })
      readWindowsPtyJobProcessIdsMock.mockReturnValue(new Set([12345, 999]))
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        vi.setSystemTime(1_000_000)
        const { id } = await provider.spawn({ cols: 80, rows: 24 })

        await expect(provider.getForegroundProcess(id)).resolves.toBe('claude')
        readWindowsPtyJobProcessIdsMock.mockReturnValue(new Set([12345, 1000]))
        await expect(provider.getForegroundProcess(id)).resolves.toBe('claude')
        vi.setSystemTime(1_000_000 + 40_000)
        await expect(provider.getForegroundProcess(id)).resolves.toBe('claude')
        expect(resolveAgentForegroundProcessMock).toHaveBeenCalledTimes(3)
        vi.setSystemTime(1_000_000 + 45_000)
        await expect(provider.getForegroundProcess(id)).resolves.toBe('claude')
        expect(resolveAgentForegroundProcessMock).toHaveBeenCalledTimes(3)
      } finally {
        vi.useRealTimers()
      }
    })

    it('drops an anchored agent when the drift recheck proves the pid was recycled', async () => {
      // A recycled PID still in the job cannot preserve an identity contradicted by the scan.
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      mockProc.process = 'powershell.exe'
      resolveAgentForegroundProcessMock
        .mockResolvedValueOnce({ available: true, processName: 'claude', processId: 999 })
        .mockResolvedValue({ available: true, processName: null, anchorPidForeign: true })
      readWindowsPtyJobProcessIdsMock.mockReturnValue(new Set([12345, 999]))
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        vi.setSystemTime(1_000_000)
        const { id } = await provider.spawn({ cols: 80, rows: 24 })

        await expect(provider.getForegroundProcess(id)).resolves.toBe('claude')

        vi.setSystemTime(1_000_000 + 40_000)
        await expect(provider.getForegroundProcess(id)).resolves.toBeNull()
        expect(resolveAgentForegroundProcessMock).toHaveBeenLastCalledWith(
          mockProc.pid,
          'powershell.exe',
          expect.objectContaining({ anchorProcessId: 999 })
        )
      } finally {
        vi.useRealTimers()
      }
    })

    it('retires the cached agent after verified shell-only membership and a no-agent scan', async () => {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: 'win32'
      })
      mockProc.process = 'powershell.exe'
      resolveAgentForegroundProcessMock
        .mockResolvedValueOnce({ available: true, processName: 'claude' })
        .mockResolvedValue({ available: true, processName: null })
      readWindowsPtyJobProcessIdsMock.mockReturnValue(new Set([12345]))
      const { id } = await provider.spawn({ cols: 80, rows: 24 })

      await expect(provider.getForegroundProcess(id)).resolves.toBe('claude')
      await expect(provider.getForegroundProcess(id)).resolves.toBeNull()
      expect(resolveAgentForegroundProcessMock).toHaveBeenCalledTimes(2)
    })
  })

  describe('confirmForegroundProcess', () => {
    it('drops a delayed result after the PTY exits', async () => {
      let resolveScan!: (resolution: { available: boolean; processName: string }) => void
      resolveAgentForegroundProcessMock.mockReturnValue(
        new Promise((resolve) => {
          resolveScan = resolve
        })
      )
      const { id } = await provider.spawn({ cols: 80, rows: 24 })

      const confirmation = provider.confirmForegroundProcess(id)
      exitCb?.({ exitCode: 0 })
      resolveScan({ available: true, processName: 'droid' })

      await expect(confirmation).resolves.toBeNull()
    })
  })
})

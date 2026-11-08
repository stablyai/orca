import type { TerminalForegroundSample } from '../../../../shared/terminal/pty/lifecycle/terminal-foreground-observation'
import '../../pty-subprocess/testing/mock-descendant-sweep'
import { describe, expect, it, vi } from 'vitest'
import type { SubprocessHandle } from '../../sessions/session-subprocess-handle'
import { TerminalHost } from '../terminal-host'

import type { IPty } from 'node-pty'
import type { WindowsProcessRow } from '../../../windows/windows-process-table'
import { createPtyForegroundProcessTracker } from '../../pty-subprocess/foreground-process-tracker'
import { inspectSpawnFileWindowsChildProcesses } from '../../pty-subprocess/spawn-file-child-processes'
import { inspectionShowsShellAlone } from '../../../runtime/terminal/lifecycle/run-terminal-shell-alone'

const { fullTable, identityTable, jobMembers, consoleMembers } = vi.hoisted(() => ({
  fullTable: vi.fn(),
  identityTable: vi.fn(),
  jobMembers: vi.fn(),
  consoleMembers: vi.fn()
}))
vi.mock('../../../windows/windows-process-table', () => ({
  readWindowsProcessTable: fullTable,
  readWindowsProcessTableFresh: fullTable,
  readWindowsProcessIdentityTable: identityTable,
  readWindowsProcessIdentityTableFresh: identityTable
}))
vi.mock('../../../providers/windows-pty-job-membership', () => ({
  readWindowsPtyJobProcessIds: jobMembers,
  isWindowsPtyJobReadable: () => true
}))
vi.mock('../../../providers/windows-console-attached-processes', () => ({
  readWindowsConsoleAttachedProcessIds: consoleMembers
}))

function createSubprocess(): SubprocessHandle {
  let onExit: ((code: number) => void) | null = null
  return {
    pid: 99_999,
    getForegroundProcess: vi.fn(() => null),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(() => onExit?.(0)),
    terminateOwnedTree: () => 'unavailable',
    forceKill: vi.fn(() => onExit?.(137)),
    signal: vi.fn(),
    onData: vi.fn(),
    onExit: (callback) => {
      onExit = callback
    },
    dispose: vi.fn()
  }
}

describe('TerminalHost process inspection', () => {
  it.each([false, true])(
    'uses fresh anchored decisions through Session (static=%s)',
    async (staticName) => {
      const platform = Object.getOwnPropertyDescriptor(process, 'platform')
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      vi.useFakeTimers({ toFake: ['Date'] })
      const nativeRow = (
        pid: number,
        ppid: number,
        name: string,
        command = name
      ): WindowsProcessRow => ({ pid, ppid, name, command })
      const shell = nativeRow(100, 1, 'powershell.exe')
      const orphan = nativeRow(120, 999, 'claude.exe', 'claude.exe --resume conversation')
      const daemon = nativeRow(130, 1, 'ssh-agent.exe', 'ssh-agent.exe -D')
      const cases: [string, boolean, WindowsProcessRow[], boolean, string?][] = [
        ['D1', false, [shell, daemon], true],
        ['known young', true, [shell, orphan], false],
        ['known old', true, [shell, orphan], false, 'old'],
        ['foreign anchor', true, [shell, { ...daemon, pid: 120 }], true],
        ['anchor absent', true, [shell, daemon], true],
        ['anchor exited', true, [shell], true],
        ['degraded incomplete', false, [shell, daemon], false, 'both'],
        ['Session exits during foreground read', false, [shell, daemon], false, 'exit']
      ]
      try {
        for (const [name, anchored, rows, admits, variant] of cases) {
          vi.setSystemTime(1000)
          let dead = false
          const base = createSubprocess()
          const proc: IPty = {
            pid: 100,
            cols: 80,
            rows: 24,
            process: 'powershell.exe',
            handleFlowControl: false,
            onData: () => ({ dispose() {} }),
            onExit: () => ({ dispose() {} }),
            resize: vi.fn(),
            clear: vi.fn(),
            write: vi.fn(),
            kill: vi.fn(),
            pause: vi.fn(),
            resume: vi.fn()
          }
          Object.assign(proc, { processNameIsSpawnFile: staticName })
          const tracker = createPtyForegroundProcessTracker({
            process: proc,
            shellPath: 'powershell.exe',
            sessionId: 'decision',
            startupAgentRecognition: null,
            isDead: () => dead
          })
          const getForegroundProcess = vi.fn(tracker.getForegroundProcess)
          const host = new TerminalHost({
            spawnSubprocess: () => ({
              ...base,
              pid: 100,
              processNameIsSpawnFile: staticName,
              getForegroundProcess,
              confirmForegroundProcess: tracker.confirmForegroundProcess,
              inspectChildProcesses: (fresh, ignoreDetached) =>
                inspectSpawnFileWindowsChildProcesses(proc, shell.name, fresh, ignoreDetached),
              onExit: (callback) =>
                base.onExit((code) => {
                  dead = true
                  tracker.markDead()
                  callback(code)
                })
            })
          })
          try {
            const created = await host.createOrAttach({
              sessionId: 'decision',
              cols: 80,
              rows: 24,
              streamClient: { onData: vi.fn(), onExit: vi.fn() }
            })
            fullTable
              .mockReset()
              .mockResolvedValue([
                shell,
                { ...orphan, ppid: 100 },
                ...(anchored ? [] : [nativeRow(121, 100, 'claude.exe')])
              ])
            consoleMembers.mockResolvedValue(new Set([100, 120, 121]))
            expect(await host.confirmForegroundProcess('decision')).toBe('claude')
            vi.setSystemTime(variant === 'old' ? 41_000 : 2000)
            fullTable.mockReset().mockImplementation(async () => {
              if (variant === 'both') {
                throw new Error('denied')
              }
              if (variant === 'exit') {
                base.kill()
              }
              return rows
            })
            identityTable.mockReset().mockResolvedValue(variant === 'both' ? [shell] : rows)
            jobMembers.mockReturnValue(new Set(rows.map((row) => row.pid)))
            consoleMembers.mockResolvedValue(new Set([100]))
            getForegroundProcess.mockClear()
            const run = () =>
              host.inspectProcess('decision', {
                expectedIncarnationId: created.incarnationId,
                scanChildProcesses: true,
                ignoreDetached: true
              })
            expect(inspectionShowsShellAlone(await run()), name).toBe(admits)
            expect(fullTable, name).toHaveBeenCalledTimes(1)
            expect(getForegroundProcess, name).not.toHaveBeenCalled()
            if (name === 'D1') {
              for (const count of [2, 20]) {
                fullTable.mockClear()
                identityTable.mockClear()
                for (let i = 0; i < count; i++) {
                  await run()
                }
                expect(fullTable).toHaveBeenCalledTimes(count)
                expect(identityTable).toHaveBeenCalledTimes(count)
              }
              expect(
                inspectionShowsShellAlone(
                  await host.inspectProcess('decision', { ignoreDetached: false })
                )
              ).toBe(false)
            }
          } finally {
            await host.dispose()
          }
        }
      } finally {
        vi.useRealTimers()
        if (platform) {
          Object.defineProperty(process, 'platform', platform)
        }
      }
    }
  )
})

describe('fresh foreground observation contract', () => {
  it('returns no child-census proof and fences a session replaced during its read', async () => {
    let finish!: (sample: TerminalForegroundSample) => void
    const subprocess = createSubprocess()
    subprocess.observeForeground = vi.fn(
      () =>
        new Promise<TerminalForegroundSample>((resolve) => {
          finish = resolve
        })
    )
    const host = new TerminalHost({ spawnSubprocess: () => subprocess })
    const created = await host.createOrAttach({
      sessionId: 'foreground-contract',
      cols: 80,
      rows: 24,
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })
    try {
      const pending = host.inspectProcess('foreground-contract', {
        foregroundOnly: true,
        expectedIncarnationId: created.incarnationId
      })
      finish({
        verdict: 'observed',
        source: 'pty-master',
        foregroundKind: 'non-shell',
        processName: 'claude'
      })
      expect(await pending).toMatchObject({
        foregroundProcess: 'claude',
        hasChildProcesses: true,
        childProcessEvidence: 'unverifiable',
        foregroundObservation: {
          ptyId: 'foreground-contract',
          ptyIncarnationId: created.incarnationId,
          verdict: 'observed'
        }
      })
      const late = host.inspectProcess('foreground-contract', { foregroundOnly: true })
      await host.kill('foreground-contract')
      finish({
        verdict: 'observed',
        source: 'pty-master',
        foregroundKind: 'non-shell',
        processName: 'claude'
      })
      expect(await late).toMatchObject({
        foregroundProcess: null,
        hasChildProcesses: true,
        foregroundObservation: { verdict: 'unverifiable', reason: 'session_changed' }
      })
    } finally {
      await host.dispose()
    }
  })
})

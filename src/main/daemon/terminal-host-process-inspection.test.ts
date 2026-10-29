import './mock-descendant-sweep'
import { describe, expect, it, vi } from 'vitest'
import type { SubprocessHandle } from './session-subprocess-handle'
import { TerminalHost } from './terminal-host'

import type { IPty } from 'node-pty'
import type { WindowsProcessRow } from '../windows/windows-process-table'
import { createPtyForegroundProcessTracker } from './pty-subprocess/foreground-process-tracker'
import { inspectSpawnFileWindowsChildProcesses } from './pty-subprocess/spawn-file-child-processes'
import { inspectionShowsShellAlone } from '../runtime/run-terminal-shell-alone'
import {
  assertCliConversationWritersExited,
  type CliWriterHost
} from '../runtime/structured-agent-cli-writers'
const { fullTable, identityTable, jobMembers, consoleMembers } = vi.hoisted(() => ({
  fullTable: vi.fn(),
  identityTable: vi.fn(),
  jobMembers: vi.fn(),
  consoleMembers: vi.fn()
}))
vi.mock('../windows/windows-process-table', () => ({
  readWindowsProcessTable: fullTable,
  readWindowsProcessTableFresh: fullTable,
  readWindowsProcessIdentityTable: identityTable,
  readWindowsProcessIdentityTableFresh: identityTable
}))
vi.mock('../providers/windows-pty-job-membership', () => ({
  readWindowsPtyJobProcessIds: jobMembers,
  isWindowsPtyJobReadable: () => true
}))
vi.mock('../providers/windows-console-attached-processes', () => ({
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
  it('returns host peer metadata and drops it when the session exits during the read', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const subprocess = createSubprocess()
    let exitDuringRead = false
    const readClaudePeerIdentity = vi.fn(async () => {
      if (exitDuringRead) {
        subprocess.kill()
      }
      return { agentName: 'remote-main-fc', agentPid: 123 }
    })
    const host = new TerminalHost({
      spawnSubprocess: () => ({
        ...subprocess,
        getForegroundProcess: () => 'claude',
        readClaudePeerIdentity
      })
    })
    try {
      const created = await host.createOrAttach({
        sessionId: 'peer',
        cols: 80,
        rows: 24,
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })
      expect(
        await host.inspectProcess('peer', { expectedIncarnationId: created.incarnationId })
      ).toMatchObject({ agentName: 'remote-main-fc', agentPid: 123 })
      expect(readClaudePeerIdentity).toHaveBeenCalledWith('claude', undefined)
      exitDuringRead = true
      const expired = await host.inspectProcess('peer')
      expect(expired.agentName).toBeUndefined()
      expect(expired.agentPid).toBeUndefined()
    } finally {
      await host.dispose()
      vi.restoreAllMocks()
    }
  })

  it('proves ordinary Windows shell children and withholds proof if its original Session exits', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const subprocess = createSubprocess()
    let exitDuringRead = false
    const inspectChildProcesses = vi.fn(async () => {
      if (exitDuringRead) {
        subprocess.kill()
      }
      return 'no-children' as const
    })
    const host = new TerminalHost({
      spawnSubprocess: () => ({
        ...subprocess,
        getForegroundProcess: () => 'powershell.exe',
        inspectChildProcesses
      })
    })
    try {
      const created = await host.createOrAttach({
        sessionId: 'exiting',
        cols: 80,
        rows: 24,
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })
      await expect(
        host.inspectProcess('exiting', { expectedIncarnationId: created.incarnationId })
      ).resolves.toMatchObject({
        foregroundProcess: 'powershell.exe',
        childProcessEvidence: 'no-children',
        foregroundProcessEvidence: {
          verdict: 'unverifiable',
          reason: 'windows_ssh_foreground_unavailable'
        }
      })
      expect(inspectChildProcesses).toHaveBeenCalledOnce()
      exitDuringRead = true
      await expect(
        host.inspectProcess('exiting', { expectedIncarnationId: created.incarnationId })
      ).resolves.toMatchObject({
        childProcessEvidence: 'unverifiable',
        foregroundProcessEvidence: { verdict: 'unverifiable', reason: 'session_changed' }
      })
    } finally {
      await host.dispose()
      vi.restoreAllMocks()
    }
  })

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
            const terminal = () => ({
              pane: {
                ptyId: 'decision',
                incarnationId: created.incarnationId,
                identity: 'decision'
              }
            })
            let alone: boolean | undefined
            const writer: CliWriterHost = {
              rows: () => [],
              saved: () => [],
              observation: () => null,
              sleeping: () => false,
              terminal,
              links: () => [
                {
                  agent: 'claude',
                  id: 'conversation',
                  paneOwned: true,
                  worktreeId: 'workspace',
                  terminal
                }
              ],
              shellAlone: async () => {
                const inspected = await host.inspectProcess('decision', {
                  expectedIncarnationId: created.incarnationId,
                  scanChildProcesses: true,
                  ignoreDetached: true
                })
                alone = inspectionShowsShellAlone(inspected)
                return alone
              }
            }
            const run = () => assertCliConversationWritersExited(writer, 'claude', 'conversation')
            const result = expect(run())
            await (admits
              ? result.resolves.toBeUndefined()
              : result.rejects.toMatchObject({ refusal: { code: 'agent_session_conflict' } }))
            expect(alone, name).toBe(admits)
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

  it('returns unverifiable when the expected incarnation is stale', async () => {
    const host = new TerminalHost({ spawnSubprocess: () => createSubprocess() })
    try {
      const created = await host.createOrAttach({
        sessionId: 'session-incarnation',
        cols: 80,
        rows: 24,
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })

      await expect(
        host.inspectProcess('session-incarnation', { expectedIncarnationId: 'replacement' })
      ).resolves.toMatchObject({
        foregroundProcessEvidence: {
          verdict: 'unverifiable',
          reason: 'incarnation_mismatch',
          ptyId: 'session-incarnation',
          ptyIncarnationId: created.incarnationId
        }
      })
    } finally {
      await host.dispose()
    }
  })
})

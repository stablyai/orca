import type * as ChildProcess from 'node:child_process'
import type * as FsPromises from 'node:fs/promises'
import './mock-descendant-sweep'
import { describe, expect, it, vi } from 'vitest'
import {
  TerminalInterfaceAuthority,
  type TerminalInterfaceTarget
} from '../agent-hooks/server/terminal-interface-authority'
import { TerminalRunFactsRegister } from '../runtime/terminal-run-facts'
import type { TerminalInterfaceBinding } from '../../shared/terminal-interface-observation'
import type { PsFixtureRow } from '../../shared/process-table-ps-test-fixture'
import type { SubprocessHandle } from './session-subprocess-handle'
import { TerminalHost } from './terminal-host'
import { Session } from './session'
import { createProcessTablePsFixture } from '../../shared/process-table-ps-test-fixture'
import { resetProcessTableSnapshotForTests } from '../../shared/process-table-snapshot-reader'
const exec = vi.hoisted(() => vi.fn())
const readProcStat = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', async (load) => ({
  ...(await load<typeof ChildProcess>()),
  execFile: exec
}))
vi.mock('node:fs/promises', async (load) => ({
  ...(await load<typeof FsPromises>()),
  readFile: readProcStat
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
      const options = { expectedIncarnationId: created.incarnationId, terminalInterface: true }
      await expect(host.inspectProcess('exiting', options)).resolves.toMatchObject({
        foregroundProcess: 'powershell.exe',
        terminalInterface: { shellForeground: true, children: 'no-children' },
        childProcessEvidence: 'no-children',
        foregroundProcessEvidence: {
          verdict: 'unverifiable',
          reason: 'windows_ssh_foreground_unavailable'
        }
      })
      expect(inspectChildProcesses).toHaveBeenCalledOnce()
      expect(inspectChildProcesses).toHaveBeenLastCalledWith(true, false)
      for (const policy of [{ steadyState: true }, { ignoreDetached: true }]) {
        inspectChildProcesses.mockClear()
        await expect(
          host.inspectProcess('exiting', { terminalInterface: true, ...policy })
        ).resolves.toMatchObject({
          terminalInterface: { shellForeground: true, children: 'no-children' }
        })
        expect(inspectChildProcesses).toHaveBeenCalledTimes(2)
        expect(inspectChildProcesses).toHaveBeenLastCalledWith(true)
      }
      exitDuringRead = true
      await expect(host.inspectProcess('exiting', options)).resolves.toMatchObject({
        childProcessEvidence: 'unverifiable',
        foregroundProcessEvidence: { verdict: 'unverifiable', reason: 'session_changed' }
      })
    } finally {
      await host.dispose()
      vi.restoreAllMocks()
    }
  })

  it('returns unverifiable when the expected incarnation is stale', async () => {
    const host = new TerminalHost({ spawnSubprocess: () => createSubprocess() })
    const interfaceRead = vi.spyOn(Session.prototype, 'inspectTerminalInterface')
    try {
      const created = await host.createOrAttach({
        sessionId: 'session-incarnation',
        cols: 80,
        rows: 24,
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })

      await expect(
        host.inspectProcess('session-incarnation', {
          expectedIncarnationId: 'replacement',
          terminalInterface: true
        })
      ).resolves.toMatchObject({
        foregroundProcessEvidence: {
          verdict: 'unverifiable',
          reason: 'incarnation_mismatch',
          ptyId: 'session-incarnation',
          ptyIncarnationId: created.incarnationId
        }
      })
      expect(interfaceRead).not.toHaveBeenCalled()
    } finally {
      interfaceRead.mockRestore()
      await host.dispose()
    }
  })
})

it('composes authority boundaries with actual host captures, bounded successors, failure and recovery', async () => {
  vi.useFakeTimers()
  vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
  resetProcessTableSnapshotForTests()
  let shell = false
  const row = (pid: number, ppid: number, tpgid: number, command: string): PsFixtureRow => ({
    pid,
    ppid,
    pgid: pid,
    tpgid,
    stat: pid === tpgid ? 'S+' : 'Ss',
    terminalMinor: pid === 99998 || ppid === 99998 ? 5 : 4,
    startTime: 'Thu Sep  3 16:02:01 2026',
    startTicks: pid,
    command
  })
  const rows = createProcessTablePsFixture(() => [
    row(99999, 1, shell ? 99999 : 99997, '/bin/zsh'),
    row(99998, 1, 99996, '/bin/zsh'),
    ...(!shell ? [row(99997, 99999, 99997, '/usr/bin/claude')] : []),
    row(99996, 99998, 99996, '/usr/bin/vim')
  ])
  readProcStat.mockImplementation(async (path: string) => rows.readProcStat(path))
  const captures: { at: number; finish: (error?: Error) => void }[] = []
  exec.mockImplementation(
    (
      _cmd: string,
      args: string[],
      _opts: unknown,
      callback: (error: Error | null, result: { stdout: string; stderr: string }) => void
    ) => {
      const stdout = rows.render(args[1])
      captures.push({
        at: performance.now(),
        finish: (error) => callback(error ?? null, { stdout, stderr: '' })
      })
    }
  )
  let pid = 99999
  const host = new TerminalHost({
    spawnSubprocess: () => ({
      ...createSubprocess(),
      pid: pid--,
      shellPath: '/bin/zsh',
      processNameIsSpawnFile: true,
      getForegroundProcess: () => 'zsh'
    })
  })
  const authority = new TerminalInterfaceAuthority()
  const facts = new TerminalRunFactsRegister()
  const off = facts.onObservationInput((id, kind) => authority.input(id, kind))
  const events: ReturnType<TerminalInterfaceAuthority['snapshotEvent']>[] = []
  const results = new Map<string, Awaited<ReturnType<TerminalHost['inspectProcess']>>>()
  let inventory: TerminalInterfaceTarget[] = []
  const disposed = vi.fn()
  const install = () =>
    authority.install({
      inventory: () => inventory,
      inspect: async (binding: TerminalInterfaceBinding) => {
        const result = await host.inspectProcess(binding.ptyId, {
          terminalInterface: true,
          expectedIncarnationId: binding.incarnationId
        })
        results.set(binding.ptyId, result)
        return result
      },
      changed: () => events.push(authority.snapshotEvent()),
      dispose: disposed
    })
  try {
    for (const id of ['one', 'two']) {
      const created = await host.createOrAttach({
        sessionId: id,
        cols: 80,
        rows: 24,
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })
      inventory.push({
        binding: {
          ptyId: id,
          incarnationId: created.incarnationId,
          terminalHandle: 'old',
          paneKey: `${id}:leaf`,
          worktreeId: 'folder:workspace'
        },
        generation: 1,
        launchToken: null,
        blocked: false,
        local: true
      })
    }
    install()
    await vi.advanceTimersByTimeAsync(1)
    expect(captures).toHaveLength(1) // Both actual Session requests shared owner admission.
    await vi.advanceTimersByTimeAsync(250)
    inventory = inventory.map((item) => ({
      ...item,
      generation: 2,
      binding: { ...item.binding, terminalHandle: 'replacement' }
    }))
    const boundary = performance.now()
    install() // Abort old waiters; keep their actual provider/capture work owned until settlement.
    expect(disposed).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1001)
    expect(captures).toHaveLength(1) // Evidence deadlines did not duplicate the pending ps.
    expect(authority.snapshot().some((item) => item.state === 'agent')).toBe(false)
    captures[0].finish()
    await vi.advanceTimersByTimeAsync(1)
    expect(captures).toHaveLength(1) // Periodic demand never forces a successor to a running wave.
    await vi.advanceTimersByTimeAsync(3500)
    expect(captures).toHaveLength(2)
    expect(captures[1].at).toBeGreaterThan(boundary)
    captures[1].finish()
    await vi.advanceTimersByTimeAsync(1)
    const birth = inventory[0].binding.incarnationId
    expect(authority.read('one', birth)?.state).toBe('agent')
    expect(results.get('two')).toMatchObject({
      foregroundProcess: 'vim',
      childProcessEvidence: 'children',
      terminalInterface: { shellForeground: false, children: 'children' }
    })
    expect(
      events.flatMap((event) => event.observations).some((item) => item.terminalHandle === 'old')
    ).toBe(false)
    await vi.advanceTimersByTimeAsync(750)
    shell = true
    facts.recordInput('one', 'driving', '/exit\r', 1)
    await vi.advanceTimersByTimeAsync(250)
    expect(captures).toHaveLength(3)
    const beforeInput = authority.read('one', birth)
    for (const kind of ['driving', 'launch'] as const) {
      facts.recordInput('one', kind, 'claude\r', 1)
    }
    const inputBoundary = performance.now()
    shell = false
    captures[2].finish() // A genuine shell table, acquired before newer input, must be discarded.
    await vi.advanceTimersByTimeAsync(1)
    expect(authority.read('one', birth)).toEqual(beforeInput)
    await vi.advanceTimersByTimeAsync(750)
    expect(captures).toHaveLength(4)
    expect(captures[3].at).toBeGreaterThan(inputBoundary)
    captures[3].finish(new Error('unreadable'))
    await vi.advanceTimersByTimeAsync(1)
    expect(results.get('one')?.terminalInterface?.children).toBe('unverifiable')
    expect(authority.read('one', birth)?.state).toBe('agent') // Unavailability preserves accepted facts.
    facts.recordInput('one', 'launch', 'claude\r', 1)
    await vi.advanceTimersByTimeAsync(250)
    expect(captures).toHaveLength(5)
    captures[4].finish()
    await vi.advanceTimersByTimeAsync(1)
    expect(authority.read('one', birth)?.state).toBe('agent')
    const revision = authority.snapshotEvent().revision
    inventory = []
    const retracted = authority.snapshotEvent()
    expect(retracted.observations).toEqual([])
    expect(events.at(-1)).toEqual(retracted)
    expect(retracted.revision).toBeGreaterThan(revision)
  } finally {
    authority.stop()
    off()
    await host.dispose()
    vi.useRealTimers()
    vi.restoreAllMocks()
    readProcStat.mockReset()
    resetProcessTableSnapshotForTests()
  }
})

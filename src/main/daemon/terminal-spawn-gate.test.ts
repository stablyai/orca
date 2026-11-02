import './mock-descendant-sweep'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { SubprocessHandle } from './session-subprocess-handle'
import { TerminalHost, type TerminalHostOptions } from './terminal-host'
import { TerminalSpawnGate, type TerminalSpawnAdmissionMode } from './terminal-spawn-gate'
import type { HostPressureLevel, SpawnIntent } from '../../shared/host-spawn-admission'
import { TERMINAL_HOST_CAP_HINT } from '../../shared/terminal-spawn-error-copy'
import { HostTerminalLedger } from './host-terminal-ledger'

type SpawnSubprocess = TerminalHostOptions['spawnSubprocess']

function stream() {
  return { onData: vi.fn(), onExit: vi.fn() }
}

describe('TerminalSpawnGate', () => {
  let host: TerminalHost
  let gate: TerminalSpawnGate
  let log: Mock<(event: string, details: Record<string, unknown>) => void>
  let exits: Map<number, (code: number) => void>
  let spawnSubprocess: Mock<SpawnSubprocess>
  let nextPid: number
  let now: number
  let useGate: (mode: TerminalSpawnAdmissionMode) => void

  beforeEach(() => {
    exits = new Map()
    nextPid = 1000
    now = 0
    log = vi.fn()
    gate = new TerminalSpawnGate({ log, now: () => now })
    useGate = (mode) => {
      gate = new TerminalSpawnGate({ log, mode, now: () => Date.now() })
      host = new TerminalHost({ spawnSubprocess, spawnGate: gate })
    }
    spawnSubprocess = vi.fn<SpawnSubprocess>(() => {
      const pid = nextPid++
      const handle: SubprocessHandle = {
        pid,
        getForegroundProcess: vi.fn(() => null),
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(() => exits.get(pid)?.(0)),
        terminateOwnedTree: () => 'unavailable' as const,
        forceKill: vi.fn(() => exits.get(pid)?.(137)),
        signal: vi.fn(),
        onData: vi.fn(),
        onExit: (callback) => {
          exits.set(pid, callback)
        },
        dispose: vi.fn()
      }
      return handle
    })
    host = new TerminalHost({ spawnSubprocess, spawnGate: gate })
  })

  afterEach(async () => {
    vi.useRealTimers()
    await host.dispose()
  })

  function restore(
    sessionId: string,
    admission: { declaredIntent?: SpawnIntent; deadlineAt?: number; signal?: AbortSignal } = {}
  ) {
    return host.createOrAttach({
      sessionId,
      cols: 80,
      rows: 24,
      historySeedChunks: ['seed'],
      agentSessionEnsure: {
        claim: {
          digestVersion: 1 as const,
          keyId: 'key',
          identityDigest: sessionId.padEnd(43, 'a'),
          worktreeScopeDigest: 'b'.repeat(43),
          agent: 'codex' as const
        },
        surface: {
          worktreeId: 'worktree',
          tabId: `tab-${sessionId}`,
          leafId: '11111111-1111-4111-8111-111111111111',
          terminalHandle: `term_${sessionId}`
        }
      },
      spawnAdmission: {
        clientId: 'client-a',
        declaredIntent: admission.declaredIntent ?? null,
        deadlineAt: admission.deadlineAt ?? Infinity
      },
      ...(admission.signal ? { cancelSignal: admission.signal } : {}),
      streamClient: stream()
    })
  }

  it('admits every automatic restore while counting the ones the policy would pace', async () => {
    for (let i = 0; i < 5; i++) {
      await restore(`restore-${i}`)
    }

    expect(spawnSubprocess).toHaveBeenCalledTimes(5)
    expect(gate.snapshot()).toMatchObject({ liveAutomatic: 5, waited: 2, deferred: 0 })
    expect(log).toHaveBeenCalledWith(
      'spawn-admission-observed',
      expect.objectContaining({ decision: 'wait', charge: 'automatic' })
    )
  })

  it('counts a remote resume that arrives with a claim but no history seed', async () => {
    await host.createOrAttach({
      sessionId: 'remote-resume',
      cols: 80,
      rows: 24,
      agentSessionEnsure: {
        claim: {
          digestVersion: 1 as const,
          keyId: 'key',
          identityDigest: 'r'.repeat(43),
          worktreeScopeDigest: 'b'.repeat(43),
          agent: 'codex' as const
        },
        surface: {
          worktreeId: 'worktree',
          tabId: 'tab-remote',
          leafId: '11111111-1111-4111-8111-111111111111',
          terminalHandle: 'term_remote'
        }
      },
      streamClient: stream()
    })
    expect(gate.snapshot().liveAutomatic).toBe(1)
  })

  it('never charges an attach and frees the live slot when the session exits', async () => {
    await restore('restore-a')
    await host.createOrAttach({
      sessionId: 'restore-a',
      cols: 80,
      rows: 24,
      attachOnly: true,
      streamClient: stream()
    })
    expect(spawnSubprocess).toHaveBeenCalledOnce()
    expect(gate.snapshot().liveAutomatic).toBe(1)

    exits.get(1000)?.(0)
    expect(gate.snapshot().liveAutomatic).toBe(0)
  })

  it('does not count a plain shell, and releases the in-flight slot when the fork throws', async () => {
    await host.createOrAttach({ sessionId: 'shell', cols: 80, rows: 24, streamClient: stream() })
    expect(gate.snapshot()).toMatchObject({ liveAutomatic: 0, inFlight: { interactive: 0 } })
    expect(log).not.toHaveBeenCalled()

    spawnSubprocess.mockImplementationOnce((options) => {
      options.onCreationDisposition?.({ kind: 'no-fork' })
      throw new Error('spawn failed')
    })
    await expect(restore('restore-fails')).rejects.toThrow('spawn failed')
    expect(gate.snapshot()).toMatchObject({ liveAutomatic: 0, inFlight: { automatic: 0 } })
  })

  it('keeps a canceled fork charged while its child refuses to die, and frees it once reaped', async () => {
    let canceled = false
    let release: (() => void) | undefined
    spawnSubprocess.mockImplementationOnce(() => {
      canceled = true
      const pid = nextPid++
      const handle: SubprocessHandle = {
        pid,
        getForegroundProcess: vi.fn(() => null),
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(),
        terminateOwnedTree: () => 'unavailable' as const,
        forceKill: vi.fn(() => {
          release = () => exits.get(pid)?.(137)
        }),
        signal: vi.fn(),
        onData: vi.fn(),
        onExit: (callback) => {
          exits.set(pid, callback)
        },
        dispose: vi.fn()
      }
      return handle
    })
    const pending = host.createOrAttach({
      sessionId: 'canceled-restore',
      cols: 80,
      rows: 24,
      historySeedChunks: ['seed'],
      agentSessionEnsure: {
        claim: {
          digestVersion: 1 as const,
          keyId: 'key',
          identityDigest: 'c'.repeat(43),
          worktreeScopeDigest: 'b'.repeat(43),
          agent: 'codex' as const
        },
        surface: {
          worktreeId: 'worktree',
          tabId: 'tab-canceled',
          leafId: '11111111-1111-4111-8111-111111111111',
          terminalHandle: 'term_canceled'
        }
      },
      isCanceled: () => canceled,
      streamClient: stream()
    })
    await vi.waitFor(() => expect(release).toBeDefined())
    expect(gate.snapshot()).toMatchObject({ liveAutomatic: 1, inFlight: { automatic: 0 } })

    release?.()
    await expect(pending).rejects.toThrow(/canceled/i)
    expect(gate.snapshot()).toMatchObject({ liveAutomatic: 0, inFlight: { automatic: 0 } })
  })

  describe('host terminal cap', () => {
    function capAt(maxTerminals: number, mode: TerminalSpawnAdmissionMode = 'observe') {
      gate = new TerminalSpawnGate({
        log,
        mode,
        now: () => Date.now(),
        hostTerminals: new HostTerminalLedger({ dir: null, maxTerminals, log })
      })
      host = new TerminalHost({ spawnSubprocess, spawnGate: gate })
    }
    const shell = (sessionId: string) =>
      host.createOrAttach({ sessionId, cols: 80, rows: 24, streamClient: stream() })

    it('refuses a new shell at the cap with a clear message and leaves running ones alone', async () => {
      capAt(2)
      await shell('a')
      await restore('b')
      await expect(shell('c')).rejects.toThrow(TERMINAL_HOST_CAP_HINT)
      await expect(restore('d')).rejects.toThrow(TERMINAL_HOST_CAP_HINT)
      expect(spawnSubprocess).toHaveBeenCalledTimes(2)
      expect(host.listSessions().filter((session) => session.isAlive)).toHaveLength(2)
      expect(gate.snapshot()).toMatchObject({ terminals: 2, hostCapRefused: 2 })
    })

    it('keeps a declared restore sleeping at the cap instead of failing its pane', async () => {
      capAt(1)
      await shell('a')
      await expect(restore('b', { declaredIntent: 'automatic-restore' })).rejects.toThrow(
        'terminal_spawn_deferred:live_cap'
      )
      await expect(restore('c', { declaredIntent: 'user-resume' })).rejects.toThrow(
        'terminal_spawn_deferred:live_cap'
      )
    })

    it('frees a slot when a terminal exits, and never charges an attach', async () => {
      capAt(1)
      await shell('a')
      await expect(
        host.createOrAttach({
          sessionId: 'a',
          cols: 80,
          rows: 24,
          attachOnly: true,
          streamClient: stream()
        })
      ).resolves.toMatchObject({ isNew: false })
      exits.get(1000)?.(0)
      await expect(shell('b')).resolves.toMatchObject({ isNew: true })
    })

    it('frees the slot of a fork that failed', async () => {
      capAt(1)
      spawnSubprocess.mockImplementationOnce((options) => {
        options.onCreationDisposition?.({ kind: 'no-fork' })
        throw new Error('spawn failed')
      })
      await expect(shell('a')).rejects.toThrow('spawn failed')
      await expect(shell('b')).resolves.toMatchObject({ isNew: true })
    })

    it('refuses a paced restore at once rather than after its wait', async () => {
      vi.useFakeTimers({ now: 0 })
      capAt(3, 'enforce')
      for (let i = 0; i < 3; i++) {
        await restore(`burst-${i}`)
      }
      await expect(restore('late', { deadlineAt: 5_000 })).rejects.toThrow(TERMINAL_HOST_CAP_HINT)
    })
  })

  describe('enforce', () => {
    beforeEach(() => {
      vi.useFakeTimers({ now: 0 })
      useGate('enforce')
    })

    it('paces an undeclared restore storm to the burst, then one per second', async () => {
      const results = Array.from({ length: 5 }, (_, i) => restore(`storm-${i}`))
      await vi.advanceTimersByTimeAsync(0)
      expect(spawnSubprocess).toHaveBeenCalledTimes(3)

      await vi.advanceTimersByTimeAsync(1000)
      expect(spawnSubprocess).toHaveBeenCalledTimes(4)
      await vi.advanceTimersByTimeAsync(1000)
      expect(spawnSubprocess).toHaveBeenCalledTimes(5)
      await Promise.all(results)
      expect(gate.snapshot()).toMatchObject({ liveAutomatic: 5, waiting: 0, waited: 2 })
    })

    it('admits an undeclared restore at its deadline instead of refusing it', async () => {
      for (let i = 0; i < 3; i++) {
        await restore(`burst-${i}`)
      }
      const late = restore('late', { deadlineAt: 400 })
      await vi.advanceTimersByTimeAsync(400)
      await expect(late).resolves.toMatchObject({ isNew: true })
      expect(spawnSubprocess).toHaveBeenCalledTimes(4)
    })

    it('tells a declared caller to keep its pane sleeping beyond the live cap', async () => {
      for (let i = 0; i < 8; i++) {
        await restore(`live-${i}`, { declaredIntent: 'automatic-restore' })
        await vi.advanceTimersByTimeAsync(1000)
      }
      await expect(restore('ninth', { declaredIntent: 'automatic-restore' })).rejects.toThrow(
        'terminal_spawn_deferred:live_cap'
      )
      expect(spawnSubprocess).toHaveBeenCalledTimes(8)

      exits.get(1000)?.(0)
      await expect(
        restore('ninth', { declaredIntent: 'automatic-restore' })
      ).resolves.toMatchObject({ isNew: true })
    })

    it('holds declared automatic restores while paused, but never user resumes or old callers', async () => {
      gate = new TerminalSpawnGate({
        log,
        mode: 'enforce',
        now: () => Date.now(),
        automaticWorkMode: () => ({ kind: 'paused', reason: 'unclean_host_death', since: 0 })
      })
      host = new TerminalHost({ spawnSubprocess, spawnGate: gate })
      await expect(restore('declared', { declaredIntent: 'automatic-restore' })).rejects.toThrow(
        'terminal_spawn_deferred:paused'
      )
      await expect(restore('opened', { declaredIntent: 'user-resume' })).resolves.toMatchObject({
        isNew: true
      })
      await expect(restore('legacy')).resolves.toMatchObject({ isNew: true })
      expect(spawnSubprocess).toHaveBeenCalledTimes(2)
    })

    it('arms the crash marker before the first automatic fork only', async () => {
      const armAutomaticWork = vi.fn()
      gate = new TerminalSpawnGate({
        log,
        mode: 'enforce',
        now: () => Date.now(),
        armAutomaticWork
      })
      host = new TerminalHost({ spawnSubprocess, spawnGate: gate })
      await host.createOrAttach({ sessionId: 'shell', cols: 80, rows: 24, streamClient: stream() })
      expect(armAutomaticWork).not.toHaveBeenCalled()
      await restore('first')
      expect(armAutomaticWork).toHaveBeenCalledOnce()
    })

    it('lets an undeclared restore wait out a growth storm, refusing it only past its deadline', async () => {
      let pressure: HostPressureLevel = 'critical'
      gate = new TerminalSpawnGate({
        log,
        mode: 'enforce',
        now: () => Date.now(),
        pressure: () => pressure
      })
      host = new TerminalHost({ spawnSubprocess, spawnGate: gate })
      const cleared = restore('cleared', { deadlineAt: 5_000 })
      await vi.advanceTimersByTimeAsync(1_000)
      expect(spawnSubprocess).not.toHaveBeenCalled()
      pressure = 'ok'
      gate.onPressureChanged()
      await expect(cleared).resolves.toMatchObject({ isNew: true })

      pressure = 'critical'
      const refused = restore('refused', { deadlineAt: Date.now() + 2_000 })
      const assertion = expect(refused).rejects.toThrow('terminal_spawn_refused')
      await vi.advanceTimersByTimeAsync(2_000)
      await assertion
      await expect(restore('declared', { declaredIntent: 'automatic-restore' })).rejects.toThrow(
        'terminal_spawn_deferred:pressure'
      )
      expect(spawnSubprocess).toHaveBeenCalledOnce()
    })

    it('never queues an interactive shell behind a restore storm', async () => {
      for (let i = 0; i < 3; i++) {
        await restore(`burst-${i}`)
      }
      const waiting = restore('waiting')
      await expect(
        host.createOrAttach({ sessionId: 'shell', cols: 80, rows: 24, streamClient: stream() })
      ).resolves.toMatchObject({ isNew: true })
      await vi.advanceTimersByTimeAsync(1000)
      await waiting
    })

    it('leaves the queue without forking when the caller cancels', async () => {
      for (let i = 0; i < 3; i++) {
        await restore(`burst-${i}`)
      }
      const controller = new AbortController()
      const canceled = restore('canceled', { signal: controller.signal })
      const assertion = expect(canceled).rejects.toThrow(/canceled/i)
      await vi.advanceTimersByTimeAsync(100)
      controller.abort()
      await assertion
      expect(spawnSubprocess).toHaveBeenCalledTimes(3)
      expect(gate.snapshot()).toMatchObject({ waiting: 0, inFlight: { automatic: 0 } })
    })
  })
})

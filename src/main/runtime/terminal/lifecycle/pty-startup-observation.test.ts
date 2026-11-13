import { afterEach, describe, expect, it, vi } from 'vitest'
import { RuntimePtyForegroundAgent } from './runtime-pty-foreground-agent'
import type { RuntimePtyController } from './runtime-pty-controller-contract'
import type { RuntimePtyWorktreeRecord } from '../records/runtime-terminal-state-records'
import { RuntimeTerminalIdlePolls } from '../wait/terminal-idle-polls'
import type { TerminalWaiter } from '../wait/terminal-waiter'
import { TerminalCommandPaint } from '../input/terminal-command-paint'
import type { TerminalProcessInspection } from '../../../../shared/terminal/pty/lifecycle/terminal-process-inspection'
import { ptyTuiIdleEvidence } from '../wait/tui-idle-evidence-source'
import { evaluateTuiIdle } from '../wait/tui-idle-evidence'
import { terminalDeliveryRefusal } from '../wait/terminal-delivery-refusal'

function inspection(processName: string | null, ptyId = 'pty-1'): TerminalProcessInspection {
  return {
    foregroundProcess: processName,
    hasChildProcesses: true,
    ...(processName
      ? {
          foregroundObservation: {
            ptyId,
            ptyIncarnationId: 'inc-1',
            authorityGeneration: 'host-1',
            observationEpoch: 1,
            capturedAgeMs: 0,
            verdict: 'observed' as const,
            source: 'pty-master' as const,
            foregroundKind: processName === 'zsh' ? ('shell' as const) : ('non-shell' as const),
            processName
          }
        }
      : {})
  }
}

function fixture(inspect: () => Promise<TerminalProcessInspection>) {
  const paint = new TerminalCommandPaint()
  paint.observe('\x1b]133;C\x07hook text', 'hook text')
  const pty = {
    ptyId: 'pty-1',
    incarnationId: 'inc-1',
    connected: true,
    lastOutputAt: 1,
    lastOscTitle: 'claude',
    commandPaint: paint
  } as unknown as RuntimePtyWorktreeRecord
  let controller = {
    getForegroundProcess: async () => 'zsh',
    inspectProcess: inspect
  } as RuntimePtyController
  const owner = new RuntimePtyForegroundAgent({
    getController: () => controller,
    getPty: () => pty,
    touchSnapshot: () => {},
    finishDelayedSnapshot: () => {}
  })
  return {
    owner,
    pty,
    replaceController(next: RuntimePtyController) {
      controller = next
    }
  }
}

async function flush() {
  await vi.advanceTimersByTimeAsync(0)
}

describe('PTY-owned startup observation', () => {
  afterEach(() => vi.useRealTimers())

  it.each([100, 1_000])('bounds observations for %i distinct interested PTYs', async (count) => {
    vi.useFakeTimers()
    const ptys = new Map<string, RuntimePtyWorktreeRecord>()
    for (let i = 0; i < count; i++) {
      const paint = new TerminalCommandPaint()
      paint.observe('\x1b]133;C\x07hook text', 'hook text')
      ptys.set(`pty-${i}`, {
        ptyId: `pty-${i}`,
        incarnationId: 'inc-1',
        connected: true,
        lastOutputAt: Date.now(),
        lastOscTitle: 'claude',
        lastAgentStatus: 'idle',
        commandPaint: paint,
        tailBuffer: ['hook text'],
        tailPartialLine: '',
        preview: 'hook text'
      } as unknown as RuntimePtyWorktreeRecord)
    }
    let recover = false
    const admissions = new Map<string, number>()
    const live = new Set<string>()
    let maxLivePerPty = 0
    const controller = {
      getForegroundProcess: async () => null,
      inspectProcess: async (id: string) => {
        admissions.set(id, (admissions.get(id) ?? 0) + 1)
        maxLivePerPty = Math.max(maxLivePerPty, live.has(id) ? 2 : 1)
        live.add(id)
        // A hung transport occupies its flight, while immediate null/error panes can retry.
        if (id === 'pty-0') {
          return new Promise<TerminalProcessInspection>(() => {})
        }
        try {
          if (recover && id === 'pty-2') {
            return inspection('fzf', id)
          }
          if (id === 'pty-1') {
            throw new Error('temporary transport failure')
          }
          return inspection(null)
        } finally {
          live.delete(id)
        }
      }
    } as RuntimePtyController
    const owner = new RuntimePtyForegroundAgent({
      getController: () => controller,
      getPty: (id) => ptys.get(id) ?? null,
      touchSnapshot: () => {},
      finishDelayedSnapshot: () => {}
    })
    const resolved = vi.fn()
    const polls = new RuntimeTerminalIdlePolls({
      intervalMs: 2_000,
      quiescenceMs: 1_500,
      getForegroundProcess: () => null,
      hasCommandPainted: () => true,
      getAdoptedPtyIdleStatus: () => null,
      getPaneAgent: () => null,
      getFirstPartyAgentStatus: () => null,
      readScreenLines: () => null,
      readVisibleScreen: () => null,
      startupObservation: owner.startup,
      resolve: resolved
    })
    const waiters: TerminalWaiter[] = []
    for (const pty of ptys.values()) {
      for (let i = 0; i < 2; i++) {
        const waiter: TerminalWaiter = {
          handle: `${pty.ptyId}-${i}`,
          ptyId: pty.ptyId,
          condition: 'tui-idle',
          resolve: () => {},
          reject: () => {},
          timeout: null,
          cancelIdlePoll: null,
          abortCleanup: null
        }
        polls.start(waiter, pty)
        waiters.push(waiter)
      }
    }
    await vi.advanceTimersByTimeAsync(10_000)
    for (const pty of ptys.values()) {
      pty.commandPaint!.observe('\x1b]133;B\x07\x1b]133;C\x07\x1b]133;D;0\x07', '')
      pty.lastOutputAt = Date.now()
    }
    for (let i = 0; i < waiters.length; i += 2) {
      waiters[i].cancelIdlePoll?.()
    }
    await vi.advanceTimersByTimeAsync(50_000)
    expect(admissions.size).toBe(count)
    expect(admissions.get('pty-0')).toBe(1)
    for (const attempts of admissions.values()) {
      expect(attempts).toBeLessThanOrEqual(6)
    }
    expect(maxLivePerPty).toBe(1)
    expect(resolved).not.toHaveBeenCalled()
    recover = true
    await vi.advanceTimersByTimeAsync(20_000)
    expect(resolved).toHaveBeenCalledWith(
      expect.objectContaining({ handle: 'pty-2-1' }),
      expect.objectContaining({ satisfied: true })
    )
    for (const waiter of waiters) {
      waiter.cancelIdlePoll?.()
    }
    const total = [...admissions.values()].reduce((sum, n) => sum + n, 0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect([...admissions.values()].reduce((sum, n) => sum + n, 0)).toBe(total)
  })

  it('keeps a positive non-TUI startup identity behind a retained candidate title', async () => {
    vi.useFakeTimers()
    const { owner, pty } = fixture(async () => inspection('dsb'))
    pty.lastAgentStatus = 'working'
    const stop = owner.startup.watch('pty-1', () => {})
    owner.startup.refresh('pty-1')
    await flush()
    const source = {
      quiescenceMs: 1500,
      getPaneAgent: () => null,
      getAdoptedPtyIdleStatus: () => null,
      getFirstPartyAgentStatus: () => null,
      readScreenLines: () => null,
      startupObservation: owner.startup
    }
    const evidence = ptyTuiIdleEvidence(source, pty, () => '')
    expect(evidence.terminalAgent).toBe('dsb')
    expect(evidence.agent).toBeNull()
    expect(
      terminalDeliveryRefusal({
        verdict: evaluateTuiIdle(evidence),
        recognizedAgent: !!evidence.terminalAgent,
        readScreenInputVeto: evidence.readScreenInputVeto
      })
    ).toBeNull()
    pty.commandPaint!.observe('\x1b]133;D;0\x07', '')
    expect(ptyTuiIdleEvidence(source, pty, () => '').terminalAgent).toBeNull()
    stop()
  })

  it('shares a hung request and ignores its result after the command changes', async () => {
    vi.useFakeTimers()
    let resolve!: (result: TerminalProcessInspection) => void
    const inspect = vi.fn(
      () =>
        new Promise<TerminalProcessInspection>((done) => {
          resolve = done
        })
    )
    const { owner, pty } = fixture(inspect)
    const changed = vi.fn()
    const stop = owner.startup.watch('pty-1', changed)
    owner.startup.refresh('pty-1')
    pty.commandPaint!.observe('\x1b]133;D;0\x07\x1b]133;C\x07new hook', 'new hook')
    owner.startup.refresh('pty-1')
    await vi.advanceTimersByTimeAsync(60_000)
    owner.startup.refresh('pty-1')
    expect(inspect).toHaveBeenCalledTimes(1)
    resolve(inspection('less'))
    await flush()
    expect(owner.startup.read('pty-1')).toEqual({ kind: 'pending', candidate: 'claude' })
    expect(changed).not.toHaveBeenCalled()
    stop()
  })

  it('rejects an old controller result without deleting the successor request', async () => {
    vi.useFakeTimers()
    let resolve!: (result: TerminalProcessInspection) => void
    const { owner, replaceController } = fixture(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    const changed = vi.fn()
    const stop = owner.startup.watch('pty-1', changed)
    owner.startup.refresh('pty-1')
    let resolveNext!: (result: TerminalProcessInspection) => void
    const nextInspect = vi.fn(
      () =>
        new Promise<TerminalProcessInspection>((done) => {
          resolveNext = done
        })
    )
    replaceController({
      getForegroundProcess: async () => null,
      inspectProcess: nextInspect
    } as RuntimePtyController)
    owner.startup.refresh('pty-1')
    resolve(inspection('less'))
    await flush()
    expect(changed).not.toHaveBeenCalled()
    owner.startup.refresh('pty-1')
    expect(nextInspect).toHaveBeenCalledTimes(1)
    resolveNext(inspection('fzf'))
    await flush()
    expect(owner.startup.read('pty-1')).toEqual({ kind: 'non-agent' })
    expect(changed).toHaveBeenCalledTimes(1)
    stop()
  })

  it('does not admit a queued successor after its last subscriber leaves, then recovers on current interest', async () => {
    vi.useFakeTimers()
    let resolve!: (result: TerminalProcessInspection) => void
    const inspect = vi.fn(
      () =>
        new Promise<TerminalProcessInspection>((done) => {
          resolve = done
        })
    )
    const { owner, pty } = fixture(inspect)
    const stop = owner.startup.watch('pty-1', () => {})
    owner.startup.refresh('pty-1')
    pty.commandPaint!.observe('\x1b]133;D;0\x07\x1b]133;C\x07new hook', 'new hook')
    owner.startup.refresh('pty-1')
    stop()
    resolve(inspection('less'))
    await flush()
    expect(inspect).toHaveBeenCalledTimes(1)
    inspect.mockResolvedValue(inspection('fzf'))
    const changed = vi.fn()
    const stopNext = owner.startup.watch('pty-1', changed)
    await vi.advanceTimersByTimeAsync(2_000)
    owner.startup.refresh('pty-1')
    await flush()
    expect(owner.startup.read('pty-1')).toEqual({ kind: 'non-agent' })
    expect(changed).toHaveBeenCalledTimes(1)
    stopNext()
  })

  it('owns a deferred confirmation through command/provider changes, then resolves the current observer', async () => {
    vi.useFakeTimers()
    let processName = 'node'
    let confirm!: (name: string) => void
    const scan = vi.fn(
      () =>
        new Promise<string>((done) => {
          confirm = done
        })
    )
    const inspect = vi.fn(async () => inspection(processName))
    const { owner, pty, replaceController } = fixture(inspect)
    replaceController({
      getForegroundProcess: async () => null,
      inspectProcess: inspect,
      confirmForegroundProcess: scan
    } as RuntimePtyController)
    const changed = vi.fn()
    const stop = owner.startup.watch('pty-1', changed)
    owner.startup.refresh('pty-1')
    await flush()
    expect(scan).toHaveBeenCalledTimes(1)
    pty.commandPaint!.observe('\x1b]133;D;0\x07\x1b]133;C\x07next hook', 'next hook')
    owner.startup.refresh('pty-1')
    pty.providerGenerationResetAtEpochMs = Date.now() + 1
    owner.startup.refresh('pty-1')
    await vi.advanceTimersByTimeAsync(60_000)
    owner.startup.refresh('pty-1')
    expect(inspect).toHaveBeenCalledTimes(1)
    expect(scan).toHaveBeenCalledTimes(1)
    processName = 'fzf'
    confirm('claude')
    await flush()
    expect(inspect).toHaveBeenCalledTimes(2)
    expect(scan).toHaveBeenCalledTimes(1)
    expect(owner.startup.read('pty-1')).toEqual({ kind: 'non-agent' })
    expect(changed).toHaveBeenCalledTimes(1)
    stop()
  })

  it('confirms native numeric Claude and leaves an unconfirmed wrapper unresolved', async () => {
    vi.useFakeTimers()
    const { owner, replaceController } = fixture(async () => inspection('2.1.322'))
    const confirm = vi.fn(async () => 'claude')
    replaceController({
      getForegroundProcess: async () => null,
      inspectProcess: async () => inspection('2.1.322'),
      confirmForegroundProcess: confirm
    } as RuntimePtyController)
    const stop = owner.startup.watch('pty-1', () => {})
    owner.startup.refresh('pty-1')
    await flush()
    expect(owner.startup.read('pty-1')).toEqual({ kind: 'agent', agent: 'claude' })
    expect(confirm).toHaveBeenCalledTimes(1)
    replaceController({
      getForegroundProcess: async () => null,
      inspectProcess: async () => inspection('node'),
      confirmForegroundProcess: async () => null
    } as RuntimePtyController)
    owner.startup.refresh('pty-1')
    await flush()
    expect(owner.startup.read('pty-1')).toEqual({ kind: 'pending', candidate: 'claude' })
    stop()
  })

  it('stops unsupported RPC admission and accepts event-driven composer evidence', async () => {
    vi.useFakeTimers()
    const inspect = vi.fn(async () => inspection('less'))
    const { owner, pty, replaceController } = fixture(inspect)
    replaceController({
      getForegroundProcess: async () => null,
      inspectProcess: inspect,
      supportsForegroundObservation: () => false
    } as RuntimePtyController)
    const stop = owner.startup.watch('pty-1', () => {})
    for (let i = 0; i < 30; i++) {
      owner.startup.refresh('pty-1')
      await vi.advanceTimersByTimeAsync(2_000)
    }
    expect(inspect).not.toHaveBeenCalled()
    pty.commandPaint!.observe('\x1b[?2031h\x1b[?2004h❯\u00a0', '❯\u00a0')
    expect(owner.startup.read('pty-1')).toEqual({ kind: 'agent', agent: 'claude' })
    stop()
  })
})

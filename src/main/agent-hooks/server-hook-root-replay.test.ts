import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PANE } from './server.test-fixtures'
import { makePaneKey } from '../../shared/stable-pane-id'
import { readHookRootEvidence, type HookPaneRoot } from '../../shared/hook-process-root-evidence'
import type { AgentHookRelayEnvelope } from '../../shared/agent-hook-relay'
import { RelayAgentHookServer } from '../../wsl-guest/agent-hook-server'
import {
  NOW,
  CLAUDE,
  NESTED,
  BACKGROUND,
  io,
  probe,
  paths,
  attempts,
  capture,
  launchServer,
  runningPane,
  hook,
  settled,
  registerRootTestHarness,
  type Proc
} from './server-hook-root.test-fixtures'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))
vi.mock('../../shared/agent-process-presence-probe', () => ({ probeAgentProcessPresence: vi.fn() }))

registerRootTestHarness()

beforeEach(() => {
  // Replay's answer deadline runs on the monotonic clock and its timers, so both are faked.
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] })
  vi.setSystemTime(NOW)
})

const ROOT_ANSWER: HookPaneRoot = { pid: 100, incarnation: 'inc-1' }
const paneOf = (index: number) =>
  makePaneKey(`tab-${index + 2}`, `${String(index).padStart(8, '0')}-0000-4000-8000-000000000000`)

function spooled(
  paneKey: string,
  pid: number | null,
  payload: Record<string, unknown>
): Record<string, unknown> {
  return {
    paneKey,
    tabId: paneKey.split(':')[0],
    worktreeId: 'wt-1',
    source: 'claude',
    receivedAt: NOW,
    ...(pid === null ? {} : { agentProcess: JSON.stringify(capture(pid)) }),
    payload
  }
}

/** Hooks that could not reach Orca while it was down, in the order they were written. */
function spoolDir(records: Record<string, unknown>[]): string {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-root-replay-'))
  paths.push(userDataPath)
  const dir = join(userDataPath, 'agent-hooks', 'spool')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'panes.jsonl'), `${records.map((r) => JSON.stringify(r)).join('\n')}\n`)
  return userDataPath
}

/** The PTY owner answers `held` panes only once released, as a slow host or cold inventory does;
 *  every other pane in `ms` ms. Resolves `requested` with the first read. */
function rootAnswers(held: (paneKey: string) => boolean, ms = 20) {
  let release = (): void => {}
  const named = new Promise<HookPaneRoot>((resolve) => {
    release = () => resolve(ROOT_ANSWER)
  })
  const requested = Promise.withResolvers<void>()
  io.resolveRoot.mockImplementation((paneKey) => {
    requested.resolve()
    if (held(paneKey)) {
      return named
    }
    // ast-grep-ignore: test-no-real-time-wait -- fake timers drive this simulated read delay
    return new Promise((resolve) => setTimeout(() => resolve(ROOT_ANSWER), ms))
  })
  return { release, requested: requested.promise }
}

describe('startup spool replay of panes without a proven owner', () => {
  it.each([[6], [60]])(
    'replays %i panes within one answer allowance, binds, then heals them with no hook',
    async (count) => {
      const panes = [...Array.from({ length: count - 1 }, (_, index) => paneOf(index)), PANE]
      const userDataPath = spoolDir(
        panes.flatMap((paneKey, index) => [
          spooled(paneKey, 49969, {
            hook_event_name: 'UserPromptSubmit',
            session_id: `s-${index}`,
            prompt: `task ${index}`
          }),
          spooled(paneKey, 49969, {
            hook_event_name: 'PostToolUse',
            session_id: `s-${index}`,
            tool_name: 'Bash'
          })
        ])
      )
      runningPane(49969, CLAUDE)
      const { release, requested } = rootAnswers(() => true)
      const startedAt = performance.now()
      const { server, started } = launchServer(userDataPath)
      await requested
      await vi.advanceTimersByTimeAsync(500)
      await started
      // One allowance for the whole drain; each pane's second record joined its pending read.
      expect(performance.now() - startedAt).toBe(500)
      expect(attempts()).toBe(count)
      panes.forEach((paneKey, index) => {
        expect(server.row(paneKey)).toMatchObject({ state: 'working', prompt: `task ${index}` })
        expect(server.presence(paneKey)).toMatchObject({ process: capture(49969), fallback: true })
      })
      // The drain's deadline is past; the late answers settle on real timers.
      vi.useRealTimers()
      release()
      await settled(count)
      for (const paneKey of panes) {
        expect(server.presence(paneKey)).toMatchObject({ process: capture(49969) })
        expect(server.presence(paneKey)?.fallback).toBeUndefined()
      }
      // The bound listener answers the healed owner's live hook, which buys no new read.
      await hook(server, 'PostToolUse', { session: `s-${count - 1}` })
      expect(attempts()).toBe(count)
    }
  )

  it('keeps a live hook on an already bound server to the same allowance when hooks turn on', async () => {
    const panes = [...Array.from({ length: 5 }, (_, index) => paneOf(index)), PANE]
    const userDataPath = spoolDir(
      panes.map((paneKey) =>
        spooled(paneKey, 49969, { hook_event_name: 'UserPromptSubmit', prompt: 'task' })
      )
    )
    runningPane(49969, CLAUDE)
    const { release, requested } = rootAnswers(() => true)
    const { server, started } = launchServer(userDataPath, {
      start: (target) =>
        target.start({ env: 'production', userDataPath, statusHooksEnabled: false })
    })
    await started
    expect(attempts()).toBe(0)
    const startedAt = performance.now()
    server.setStatusHooksEnabled(true)
    // A live hook arriving during the first initialization waits for its replay.
    const live = hook(server, 'PostToolUse', { session: 'live' })
    await requested
    await vi.advanceTimersByTimeAsync(500)
    await live
    expect(performance.now() - startedAt).toBe(500)
    expect(attempts()).toBe(6)
    vi.useRealTimers()
    release()
    await settled(6)
    expect(server.presence()?.fallback).toBeUndefined()
  })

  it('hands an answer after the spent allowance to the host, which heals and retires once', async () => {
    const [slow, healed, exiting] = [paneOf(0), paneOf(1), paneOf(2)]
    const userDataPath = spoolDir([
      spooled(slow, 49969, { hook_event_name: 'UserPromptSubmit', session_id: 'a', prompt: 'A' }),
      spooled(healed, null, { hook_event_name: 'UserPromptSubmit', session_id: 'b', prompt: 'B' }),
      spooled(healed, 49969, {
        hook_event_name: 'PostToolUse',
        session_id: 'b',
        tool_name: 'Bash'
      }),
      spooled(exiting, null, { hook_event_name: 'UserPromptSubmit', session_id: 'c', prompt: 'C' }),
      spooled(exiting, 49969, {
        hook_event_name: 'PostToolUse',
        session_id: 'c',
        tool_name: 'Bash'
      }),
      // The final exit joins the pending read; it is owed once that read proves the root.
      spooled(exiting, 49969, {
        hook_event_name: 'SessionEnd',
        session_id: 'c',
        reason: 'prompt_input_exit'
      })
    ])
    runningPane(49969, CLAUDE)
    const { release, requested } = rootAnswers((paneKey) => paneKey === slow)
    const { server, started } = launchServer(userDataPath)
    await requested
    await vi.advanceTimersByTimeAsync(500)
    await started
    expect(server.presence(healed)).toEqual({ agent: 'claude', session: 'b' })
    // Both answers arrive well before either pair's own 500 ms would have ended.
    await vi.advanceTimersByTimeAsync(20)
    expect(server.presence(healed)).toMatchObject({ process: capture(49969), session: 'b' })
    expect(server.row(healed)).toMatchObject({ prompt: 'B' })
    expect(server.presence(exiting)).toMatchObject({ process: capture(49969), ended: true })
    expect(server.exits).toBe(1)
    vi.useRealTimers()
    release()
    await settled(3)
    expect(server.exits).toBe(1)
  })

  it.each<[string, Proc[], number]>([
    ['nested run', NESTED, 49980],
    ['background agent beside the pane’s own', [BACKGROUND], 49990]
  ])(
    'refuses a %s whose answer fits the allowance, and again from cached evidence once it is spent',
    async (_name, procs, pid) => {
      const slow = paneOf(0)
      const userDataPath = spoolDir([
        spooled(PANE, null, {
          hook_event_name: 'UserPromptSubmit',
          session_id: 'parent',
          prompt: 'Parent task'
        }),
        spooled(PANE, pid, {
          hook_event_name: 'UserPromptSubmit',
          session_id: 'child',
          prompt: 'Child task'
        }),
        spooled(slow, 49969, { hook_event_name: 'UserPromptSubmit', session_id: 'a', prompt: 'A' }),
        spooled(PANE, pid, {
          hook_event_name: 'UserPromptSubmit',
          session_id: 'child',
          prompt: 'Child again'
        })
      ])
      runningPane(49969, CLAUDE, ...procs)
      const { release, requested } = rootAnswers((paneKey) => paneKey === slow)
      const startedAt = performance.now()
      const { server, started } = launchServer(userDataPath)
      await requested
      await vi.advanceTimersByTimeAsync(500)
      await started
      expect(performance.now() - startedAt).toBe(500)
      expect(server.row()).toMatchObject({ prompt: 'Parent task' })
      expect(server.presence()).toEqual({ agent: 'claude', session: 'parent' })
      release()
    }
  )

  it('answers past 64 unfinished reads as unknown, and reads that pane on its next turn', async () => {
    const panes = [...Array.from({ length: 69 }, (_, index) => paneOf(index)), PANE]
    const userDataPath = spoolDir(
      panes.map((paneKey) =>
        spooled(paneKey, 49969, { hook_event_name: 'UserPromptSubmit', prompt: 'task' })
      )
    )
    runningPane(49969, CLAUDE)
    const { release, requested } = rootAnswers(() => true)
    const { server, started } = launchServer(userDataPath)
    await requested
    await vi.advanceTimersByTimeAsync(500)
    await started
    expect(attempts()).toBe(64)
    vi.useRealTimers()
    release()
    await settled(64)
    expect(server.presence(panes[0])?.fallback).toBeUndefined()
    expect(server.presence()).toMatchObject({ process: capture(49969), fallback: true })
    await hook(server, 'UserPromptSubmit', { prompt: 'next' })
    expect(attempts()).toBe(65)
    expect(server.presence()?.fallback).toBeUndefined()
  })
})

describe('WSL relay startup spool replay', () => {
  it.each([[6], [60]])(
    'replays %i panes within one answer allowance before binding, then forwards each heal',
    async (count) => {
      const panes = Array.from({ length: count }, (_, index) => paneOf(index))
      const endpointDir = join(
        spoolDir(
          panes.map((paneKey) =>
            spooled(paneKey, 49969, { hook_event_name: 'UserPromptSubmit', prompt: 'task' })
          )
        ),
        'agent-hooks'
      )
      runningPane(49969, CLAUDE)
      probe.mockResolvedValue('live')
      const { release, requested } = rootAnswers(() => true)
      const forward = vi.fn<(event: AgentHookRelayEnvelope) => void>()
      const relay = new RelayAgentHookServer({
        endpointDir,
        forward,
        readHookRootEvidence: (request) => readHookRootEvidence(request, io)
      })
      try {
        const startedAt = performance.now()
        const started = relay.start()
        await requested
        await vi.advanceTimersByTimeAsync(500)
        await started
        expect(performance.now() - startedAt).toBe(500)
        expect(relay.getCoordinates().port).toBeGreaterThan(0)
        expect(attempts()).toBe(count)
        vi.useRealTimers()
        forward.mockClear()
        release()
        await vi.waitFor(() => {
          const healed = forward.mock.calls
            .map(([event]) => event)
            .filter((event) => event.agentPresence?.process && !event.agentPresence.fallback)
          expect(new Set(healed.map((event) => event.paneKey)).size).toBe(count)
        })
      } finally {
        relay.stop()
      }
    }
  )
})

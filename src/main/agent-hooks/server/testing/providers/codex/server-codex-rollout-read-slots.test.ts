import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { AgentHookServer, _internals } from '../../../agent-hook-server'
import { buildBody } from '../../server.test-fixtures'
import {
  BASH,
  childMeta,
  event,
  taskStarted,
  turnContext
} from './codex-rollout-records.test-fixtures'
import { makePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import { rolloutReadLimiterForTests as slots } from '../../../../../../shared/agent-hook-listener/providers/codex/codex-rollout-async-reads'

// Opens can be slowed per file (how an on-access scanner holding a rollout looks); every handle
// opened is counted until it closes, and reader calls in flight are counted across all files.
const io = vi.hoisted(() => {
  const state: {
    openDelayMs: (filePath: string) => number
    opened: number
    openedPaths: string[]
    closed: number
    readersInFlight: number
    maxReadersInFlight: number
    pending: Set<Promise<unknown>>
  } = {
    openDelayMs: () => 0,
    opened: 0,
    openedPaths: [],
    closed: 0,
    readersInFlight: 0,
    maxReadersInFlight: 0,
    pending: new Set()
  }
  return state
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const delayMs = io.openDelayMs(String(args[0]))
      if (delayMs > 0) {
        // ast-grep-ignore: test-no-real-time-wait -- a slow open on fake timers that settle() drives
        await new Promise((resolve) => setTimeout(resolve, delayMs))
      }
      const handle = await actual.open(...args)
      io.opened += 1
      io.openedPaths.push(String(args[0]))
      const close = handle.close.bind(handle)
      handle.close = async () => {
        io.closed += 1
        return close()
      }
      return handle
    }
  }
})

vi.mock(
  '../../../../../../shared/agent-hook-listener/providers/codex/codex-rollout-async-reads',
  async (importOriginal) => {
    const actual = await importOriginal<typeof AsyncRead>()
    const counted =
      <A extends unknown[], R>(read: (...args: A) => Promise<R>) =>
      (...args: A): Promise<R> => {
        io.readersInFlight += 1
        io.maxReadersInFlight = Math.max(io.maxReadersInFlight, io.readersInFlight)
        const pending = read(...args).finally(() => {
          io.readersInFlight -= 1
          io.pending.delete(pending)
        })
        io.pending.add(pending)
        return pending
      }
    return {
      ...actual,
      readJsonlCursorBytes: counted(actual.readJsonlCursorBytes),
      readJsonlFirstRecordAsync: counted(actual.readJsonlFirstRecordAsync)
    }
  }
)

import type * as FsPromises from 'node:fs/promises'
import type * as AsyncRead from '../../../../../../shared/agent-hook-listener/providers/codex/codex-rollout-async-reads'

const userReviewer = (turnId: string): string => turnContext(turnId, 'user')

let server: AgentHookServer
let dir: string
let samples: { inFlight: number; queued: number }[]

function pane(index: number): string {
  return makePaneKey(`tab-${index}`, `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`)
}

function rollout(name: string, ...lines: string[]): string {
  const path = join(dir, `rollout-${name}.jsonl`)
  writeFileSync(path, lines.join(''))
  return path
}

async function post(paneKey: string, payload: Record<string, unknown>): Promise<void> {
  const env = server.buildPtyEnv()
  const response = await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/codex`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Connection: 'close',
      'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
    },
    body: JSON.stringify(
      buildBody(
        { session_id: `session-${paneKey}`, ...payload },
        { paneKey, tabId: paneKey.split(':')[0] }
      )
    )
  })
  expect(response.status).toBe(204)
}

function shown(paneKey: string): unknown {
  const row = server.getStatusSnapshot().find((entry) => entry.paneKey === paneKey)
  return [row?.state, row?.mainAgent?.outcome, row?.subagents?.map((child) => child.description)]
}

/** Real (unfaked) event-loop turns, so file I/O can land between fake-time steps. */
async function realTurns(count: number): Promise<void> {
  for (let turn = 0; turn < count; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

/** Let real file I/O land and fake time run in 100 ms steps, sampling the read slots. */
async function settle(ms: number): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += 100) {
    for (let pass = 0; pass < 10 && io.pending.size > 0; pass += 1) {
      await Promise.race([Promise.allSettled(io.pending), realTurns(20)])
      await vi.advanceTimersByTimeAsync(0)
    }
    await vi.advanceTimersByTimeAsync(100)
    samples.push({ inFlight: slots.inFlight(), queued: slots.queued() })
  }
}

beforeEach(async () => {
  vi.useFakeTimers({
    toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance']
  })
  _internals.resetCachesForTests()
  Object.assign(io, {
    openDelayMs: () => 0,
    opened: 0,
    openedPaths: [],
    closed: 0,
    readersInFlight: 0,
    maxReadersInFlight: 0
  })
  samples = []
  dir = mkdtempSync(join(tmpdir(), 'codex-rollout-slots-'))
  server = new AgentHookServer()
  await server.start({ env: 'production' })
})

afterEach(() => {
  server.stop()
  rmSync(dir, { recursive: true, force: true })
  vi.useRealTimers()
})

/** Deterministic PRNG so a failing seed replays. */
function mulberry32(seed: number): () => number {
  let value = seed
  return () => {
    value = (value + 0x6d2b79f5) | 0
    let mixed = Math.imul(value ^ (value >>> 15), 1 | value)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296
  }
}

describe('Codex rollout reads share two slots per process', () => {
  it('keeps at most two reads in flight across many busy panes and ends every pane as without delay', async () => {
    const random = mulberry32(7)
    io.openDelayMs = () => Math.floor(random() * 1_500)
    const PANES = 8
    let files = 0
    for (let index = 0; index < PANES; index += 1) {
      const key = pane(index)
      const root = rollout(`root-${index}`, taskStarted('turn-1'), userReviewer('turn-1'))
      files += 1
      await post(key, {
        turn_id: 'turn-1',
        transcript_path: root,
        hook_event_name: 'UserPromptSubmit'
      })
      if (index % 2 === 0) {
        await post(key, {
          turn_id: 'turn-1',
          transcript_path: root,
          hook_event_name: 'PermissionRequest',
          ...BASH
        })
      } else {
        const childId = `019fa65f-0000-7000-8000-${String(index).padStart(12, '0')}`
        const child = rollout(
          `child-${index}`,
          childMeta(childId, `/root/scout${index}`),
          taskStarted('c')
        )
        files += 1
        await post(key, {
          transcript_path: child,
          hook_event_name: 'SubagentStart',
          agent_id: childId
        })
        // Each busy pane keeps writing; the tail must coalesce instead of queueing every write.
        for (let write = 0; write < 5; write += 1) {
          appendFileSync(root, event({ type: 'token_count' }))
          appendFileSync(child, event({ type: 'token_count' }))
        }
      }
    }
    await settle(15_000)

    expect(io.maxReadersInFlight).toBeLessThanOrEqual(2)
    expect(Math.max(...samples.map((sample) => sample.inFlight))).toBeLessThanOrEqual(2)
    expect(Math.max(...samples.map((sample) => sample.queued))).toBeLessThanOrEqual(files)
    for (let index = 0; index < PANES; index += 1) {
      expect([index, shown(pane(index))]).toEqual([
        index,
        index % 2 === 0
          ? ['waiting', undefined, undefined]
          : ['working', undefined, [`scout${index}`]]
      ])
    }
    expect(io.closed).toBe(io.opened)
  })

  it('times out hung reads so other panes get their slots back, then reads the hung files again', async () => {
    const hungPanes = [pane(0), pane(1)]
    const otherPane = pane(2)
    const hung = hungPanes.map((_, index) =>
      rollout(`hung-${index}`, taskStarted('turn-1'), userReviewer('turn-1'))
    )
    const other = rollout('other', taskStarted('turn-1'))
    const hungNames = new Set(hung.map((path) => basename(path)))
    io.openDelayMs = (filePath) => {
      const name = basename(filePath)
      if (hungNames.has(name)) {
        hungNames.delete(name)
        return 8_000
      }
      return 0
    }
    for (const [index, key] of hungPanes.entries()) {
      await post(key, {
        turn_id: 'turn-1',
        transcript_path: hung[index],
        hook_event_name: 'UserPromptSubmit'
      })
      await post(key, {
        turn_id: 'turn-1',
        transcript_path: hung[index],
        hook_event_name: 'PermissionRequest',
        ...BASH
      })
    }
    await post(otherPane, {
      turn_id: 'turn-1',
      transcript_path: other,
      hook_event_name: 'UserPromptSubmit'
    })
    appendFileSync(
      other,
      event({ type: 'task_complete', turn_id: 'turn-1', error: { message: 'x' } })
    )

    // Both slots are held by the hung reads, so the other pane waits instead of adding threadpool work.
    await settle(4_000)
    expect(slots.inFlight()).toBe(2)
    expect(shown(otherPane)).toEqual(['working', undefined, undefined])

    // At 5 s the hung reads give their slots back: the other pane ends and the approvals show.
    await settle(2_000)
    expect(shown(otherPane)).toEqual(['done', 'failure', undefined])
    for (const key of hungPanes) {
      expect(shown(key)).toEqual(['waiting', undefined, undefined])
    }

    // The hung opens finally return; their handles close and the files are read again.
    await settle(6_000)
    for (const key of hungPanes) {
      expect(shown(key)).toEqual(['waiting', undefined, undefined])
    }
    expect(slots.inFlight()).toBe(0)
    expect(slots.queued()).toBe(0)
    expect(io.closed).toBe(io.opened)
    for (const path of hung) {
      expect(io.openedPaths.filter((opened) => opened === path).length).toBeGreaterThan(1)
    }
  })

  it('lets at most one timed-out read keep its I/O beyond the two slots', async () => {
    const keys = [0, 1, 2, 3].map(pane)
    const files = keys.map((_, index) =>
      rollout(`hung-${index}`, taskStarted('turn-1'), userReviewer('turn-1'))
    )
    const slowed = new Set<string>()
    io.openDelayMs = (filePath) => {
      if (slowed.has(filePath)) {
        return 0
      }
      slowed.add(filePath)
      return 8_000
    }
    for (const [index, key] of keys.entries()) {
      await post(key, {
        turn_id: 'turn-1',
        transcript_path: files[index],
        hook_event_name: 'UserPromptSubmit'
      })
    }
    await settle(20_000)
    // Two slots plus one read past its timeout: a pool thread stays free for the rest of the process.
    expect(io.maxReadersInFlight).toBe(3)
    expect(io.closed).toBe(io.opened)
    expect(slots.inFlight()).toBe(0)
  })

  it('keeps reading other panes when opens never return', async () => {
    const stuck = [0, 1, 2].map((index) => rollout(`stuck-${index}`, taskStarted('turn-1')))
    const stuckNames = new Set(stuck.map((path) => basename(path)))
    io.openDelayMs = (filePath) => (stuckNames.has(basename(filePath)) ? 1e9 : 0)
    for (const [index, path] of stuck.entries()) {
      await post(pane(index), {
        turn_id: 'turn-1',
        transcript_path: path,
        hook_event_name: 'UserPromptSubmit'
      })
    }
    await settle(6_000)
    const other = rollout('other', taskStarted('turn-1'))
    await post(pane(3), {
      turn_id: 'turn-1',
      transcript_path: other,
      hook_event_name: 'UserPromptSubmit'
    })
    appendFileSync(
      other,
      event({ type: 'task_complete', turn_id: 'turn-1', error: { message: 'x' } })
    )
    await settle(40_000)
    expect(shown(pane(3))).toEqual(['done', 'failure', undefined])
  })

  it('reads a busy pane only once its hooks go quiet, and still catches a turn end without a hook', async () => {
    const key = pane(0)
    const root = rollout('busy', taskStarted('turn-1'), userReviewer('turn-1'))
    await post(key, {
      turn_id: 'turn-1',
      transcript_path: root,
      hook_event_name: 'UserPromptSubmit'
    })
    await settle(500)
    const opensBefore = io.opened
    // Ten seconds of a working turn: a tool hook and a rollout write every 500 ms.
    for (let tick = 0; tick < 20; tick += 1) {
      appendFileSync(root, event({ type: 'token_count' }))
      await post(key, {
        turn_id: 'turn-1',
        transcript_path: root,
        hook_event_name: 'PostToolUse',
        ...BASH
      })
      await settle(500)
    }
    expect(io.opened - opensBefore).toBeLessThanOrEqual(2)
    // The turn then fails: no hook, only the rollout says so.
    appendFileSync(
      root,
      event({ type: 'task_complete', turn_id: 'turn-1', error: { message: 'x' } })
    )
    await settle(2_500)
    expect(shown(key)).toEqual(['done', 'failure', undefined])
  })

  it('never opens a queued child name read once its pane closed', async () => {
    const hung = [
      rollout('hung-0', taskStarted('turn-1')),
      rollout('hung-1', taskStarted('turn-1'))
    ]
    const hungNames = new Set(hung.map((path) => basename(path)))
    // Only the first open of each is slow, so every read has drained when the test ends.
    io.openDelayMs = (filePath) => (hungNames.delete(basename(filePath)) ? 8_000 : 0)
    for (const [index, path] of hung.entries()) {
      await post(pane(index), {
        turn_id: 'turn-1',
        transcript_path: path,
        hook_event_name: 'UserPromptSubmit'
      })
    }
    await settle(300)
    expect(slots.inFlight()).toBe(2)
    const root = rollout('closing-root', taskStarted('turn-1'))
    const child = rollout('closing-child', childMeta('child-a', '/root/scout'))
    await post(pane(2), {
      turn_id: 'turn-1',
      transcript_path: root,
      hook_event_name: 'UserPromptSubmit'
    })
    await post(pane(2), {
      transcript_path: child,
      hook_event_name: 'SubagentStart',
      agent_id: 'child-a'
    })
    server.clearPaneState(pane(2))
    await settle(12_000)
    expect(io.openedPaths.filter((path) => basename(path) === basename(child))).toEqual([])
    expect(io.closed).toBe(io.opened)
  })

  it('never opens a queued rollout whose pane stopped wanting it before a slot came', async () => {
    const hung = [
      rollout('hung-0', taskStarted('turn-1')),
      rollout('hung-1', taskStarted('turn-1'))
    ]
    const hungNames = new Set(hung.map((path) => basename(path)))
    io.openDelayMs = (filePath) => (hungNames.has(basename(filePath)) ? 8_000 : 0)
    for (const [index, path] of hung.entries()) {
      await post(pane(index), {
        turn_id: 'turn-1',
        transcript_path: path,
        hook_event_name: 'UserPromptSubmit'
      })
      appendFileSync(path, event({ type: 'token_count' }))
    }
    await settle(300)
    expect(slots.inFlight()).toBe(2)
    const abandoned = rollout('abandoned', taskStarted('turn-1'))
    await post(pane(2), {
      turn_id: 'turn-1',
      transcript_path: abandoned,
      hook_event_name: 'UserPromptSubmit'
    })
    expect(slots.queued()).toBe(1)
    // A new session replaces the pane's rollout before the queued read gets a slot.
    const replacement = rollout('replacement', taskStarted('turn-2'))
    await post(pane(2), {
      transcript_path: replacement,
      hook_event_name: 'SessionStart',
      source: 'startup'
    })
    await settle(12_000)
    expect(io.openedPaths.filter((path) => basename(path) === basename(abandoned))).toEqual([])
    expect(io.closed).toBe(io.opened)
  })
})

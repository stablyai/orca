import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AgentHookServer, _internals } from '../../../agent-hook-server'
import { buildBody, GOOD_PANE, PANE } from '../../server.test-fixtures'
import {
  BASH,
  childMeta,
  event,
  ROOT_ID,
  sessionMeta,
  taskComplete,
  taskStarted,
  turnAborted,
  turnContext
} from './codex-rollout-records.test-fixtures'
import {
  holdReads,
  reads,
  resetRolloutReadGate,
  settle
} from './codex-rollout-read-gate.test-fixtures'

vi.mock(
  '../../../../../../shared/agent-hook-listener/providers/codex/codex-rollout-async-reads',
  async (importOriginal) =>
    (await import('./codex-rollout-read-gate.test-fixtures')).gatedRolloutReads(importOriginal)
)

const CHILD_ID = '019fa65f-0000-7000-8000-0000000000c1'
const GRANDCHILD_ID = '019fa65f-0000-7000-8000-0000000000c2'
const T1 = 'turn-1'
const T2 = 'turn-2'

type Row = ReturnType<AgentHookServer['getStatusSnapshot']>[number]

let server: AgentHookServer
let dir: string
let published: { state: string }[]

function rollout(name: string, ...lines: string[]): string {
  const path = join(dir, `rollout-${name}.jsonl`)
  writeFileSync(path, lines.join(''))
  return path
}

async function post(payload: Record<string, unknown>): Promise<void> {
  const env = server.buildPtyEnv()
  const response = await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/codex`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Connection: 'close',
      'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
    },
    body: JSON.stringify(buildBody({ session_id: ROOT_ID, ...payload }))
  })
  expect(response.status).toBe(204)
}

function row(paneKey = PANE): Row | undefined {
  return server.getStatusSnapshot().find((entry) => entry.paneKey === paneKey)
}

/** The status facts the sidebar shows, for comparing whole timelines and end states. */
function shown(entry: Row | undefined): Record<string, unknown> {
  return {
    state: entry?.state,
    interrupted: entry?.interrupted ?? false,
    outcome: entry?.mainAgent?.outcome,
    subagents: entry?.subagents?.map((child) => [child.description, child.state]) ?? []
  }
}

async function startServer(): Promise<void> {
  published = []
  server = new AgentHookServer()
  await server.start({ env: 'production' })
  server.setListener((entry) => {
    if (entry.paneKey === PANE && !entry.isReplay) {
      published.push({ state: entry.payload.state })
    }
  })
}

beforeEach(async () => {
  vi.useFakeTimers({
    toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance']
  })
  _internals.resetCachesForTests()
  resetRolloutReadGate()
  dir = mkdtempSync(join(tmpdir(), 'codex-rollout-reads-'))
  await startServer()
})

afterEach(() => {
  server.stop()
  rmSync(dir, { recursive: true, force: true })
  vi.useRealTimers()
})

describe('Codex status from hooks, with async rollout reads only for what hooks lack', () => {
  it('tracks v2 and nested children from hooks and names them from their own rollout header', async () => {
    const root = rollout('root', sessionMeta('0.169.0'), taskStarted(T1))
    const child = rollout('child', childMeta(CHILD_ID, '/root/scout'))
    const grandchild = rollout('grandchild', childMeta(GRANDCHILD_ID, '/root/scout/deep'))
    await post({ turn_id: T1, transcript_path: root, hook_event_name: 'UserPromptSubmit' })
    await post({
      turn_id: 'child-turn',
      transcript_path: child,
      hook_event_name: 'SubagentStart',
      agent_id: CHILD_ID,
      agent_type: 'default'
    })
    await post({
      turn_id: 'grandchild-turn',
      transcript_path: grandchild,
      hook_event_name: 'SubagentStart',
      agent_id: GRANDCHILD_ID,
      agent_type: 'default'
    })
    await settle(1_000)
    expect(shown(row()).subagents).toEqual([
      ['scout', 'working'],
      ['scout/deep', 'working']
    ])

    // Codex names the immediate parent's rollout as a grandchild's SubagentStop transcript.
    await post({
      transcript_path: child,
      agent_transcript_path: grandchild,
      hook_event_name: 'SubagentStop',
      agent_id: GRANDCHILD_ID
    })
    await post({
      transcript_path: root,
      agent_transcript_path: child,
      hook_event_name: 'SubagentStop',
      agent_id: CHILD_ID
    })
    expect(shown(row()).subagents).toEqual([])
    await post({ turn_id: T1, transcript_path: root, hook_event_name: 'Stop' })
    expect(shown(row())).toEqual({
      state: 'done',
      interrupted: false,
      outcome: undefined,
      subagents: []
    })
  })

  it('ends a /review turn and a failed turn from the rollout, since Codex sends no Stop for either', async () => {
    const review = rollout('review', taskStarted(T1))
    await post({ turn_id: T1, transcript_path: review, hook_event_name: 'UserPromptSubmit' })
    await post({ turn_id: T1, transcript_path: review, hook_event_name: 'PreToolUse', ...BASH })
    appendFileSync(review, taskComplete(T1))
    await settle()
    expect(shown(row())).toEqual({
      state: 'done',
      interrupted: false,
      outcome: undefined,
      subagents: []
    })

    const failed = rollout('failed', taskStarted(T2))
    await post({ turn_id: T2, transcript_path: failed, hook_event_name: 'UserPromptSubmit' })
    appendFileSync(failed, taskComplete(T2, { message: 'model_not_found' }))
    await settle()
    expect(shown(row())).toEqual({
      state: 'done',
      interrupted: false,
      outcome: 'failure',
      subagents: []
    })
  })

  it('settles a cancel from Interrupt on Codex 0.150+, where a Ctrl+C copy leaves the turn running', async () => {
    const root = rollout('root', sessionMeta('0.169.0'), taskStarted(T1))
    await post({ turn_id: T1, transcript_path: root, hook_event_name: 'UserPromptSubmit' })
    await post({ turn_id: T1, transcript_path: root, hook_event_name: 'PreToolUse', ...BASH })
    // The hook, not the rollout, is the cancel: an abort record alone changes nothing on 0.150+.
    appendFileSync(root, turnAborted(T1))
    await settle()
    expect(row()?.state).toBe('working')
    await post({ turn_id: T1, transcript_path: root, hook_event_name: 'Interrupt' })
    expect(shown(row())).toEqual({
      state: 'done',
      interrupted: true,
      outcome: 'cancellation',
      subagents: []
    })

    appendFileSync(root, taskStarted(T2))
    await post({ turn_id: T2, transcript_path: root, hook_event_name: 'UserPromptSubmit' })
    await post({ turn_id: T2, transcript_path: root, hook_event_name: 'PreToolUse', ...BASH })
    await settle()
    expect(row()?.state).toBe('working')
    await post({ turn_id: T2, transcript_path: root, hook_event_name: 'Stop' })
    expect(shown(row())).toEqual({
      state: 'done',
      interrupted: false,
      outcome: undefined,
      subagents: []
    })
  })

  it('cancels from the rollout on Codex before 0.150, which has no Interrupt hook', async () => {
    const root = rollout('root', sessionMeta('0.146.0'), taskStarted(T1))
    await post({ turn_id: T1, transcript_path: root, hook_event_name: 'UserPromptSubmit' })
    await post({ turn_id: T1, transcript_path: root, hook_event_name: 'PreToolUse', ...BASH })
    appendFileSync(root, turnAborted(T1))
    await settle()
    expect(shown(row())).toEqual({
      state: 'done',
      interrupted: true,
      outcome: 'cancellation',
      subagents: []
    })
  })

  it('keeps the rollout cancel check when the pane does not show its own Codex version', async () => {
    const root = rollout('root', taskStarted(T1))
    await post({ turn_id: T1, transcript_path: root, hook_event_name: 'UserPromptSubmit' })
    appendFileSync(root, turnAborted(T1))
    await settle()
    expect(shown(row())).toEqual({
      state: 'done',
      interrupted: true,
      outcome: 'cancellation',
      subagents: []
    })
  })

  it('classifies an approval at once from the reviewer its turn already read, then rechecks it', async () => {
    const root = rollout('root', taskStarted(T1), turnContext(T1, 'user'))
    await post({ turn_id: T1, transcript_path: root, hook_event_name: 'UserPromptSubmit' })
    await settle(500)
    await post({
      turn_id: T1,
      transcript_path: root,
      hook_event_name: 'PermissionRequest',
      ...BASH
    })
    expect(row()?.state).toBe('waiting')

    await post({ turn_id: T1, transcript_path: root, hook_event_name: 'PostToolUse', ...BASH })
    appendFileSync(
      root,
      event({
        type: 'thread_settings_applied',
        thread_settings: { approvals_reviewer: 'auto_review' }
      })
    )
    await post({
      turn_id: T1,
      transcript_path: root,
      hook_event_name: 'PermissionRequest',
      ...BASH
    })
    await settle()
    expect(row()?.state).toBe('working')
  })

  it('never shows an approval Codex reviews itself as Needs you, and shows a user approval', async () => {
    const root = rollout('root', taskStarted(T1), turnContext(T1, 'auto_review'))
    await post({ turn_id: T1, transcript_path: root, hook_event_name: 'UserPromptSubmit' })
    await post({ turn_id: T1, transcript_path: root, hook_event_name: 'PreToolUse', ...BASH })
    await post({
      turn_id: T1,
      transcript_path: root,
      hook_event_name: 'PermissionRequest',
      ...BASH
    })
    await settle()
    expect(row()?.state).toBe('working')

    appendFileSync(root, turnContext(T1, 'user'))
    await post({
      turn_id: T1,
      transcript_path: root,
      hook_event_name: 'PermissionRequest',
      ...BASH
    })
    await settle()
    expect(row()?.state).toBe('waiting')
    expect(published.slice(0, -1).some((entry) => entry.state === 'waiting')).toBe(false)
  })
})

/** Hold every read after its bytes were read; `captured` resolves once the first read has them. */

describe('Codex children that end without a SubagentStop', () => {
  // Codex 0.169 writes a spawned child's rollout with its own header, then a fork of the parent's
  // history, then the child's turns; only the last lifecycle record says how the child ended.
  const childRollout = (childTurn: string): string =>
    rollout(
      'child',
      childMeta(CHILD_ID, '/root/scout'),
      sessionMeta('0.169.0'),
      taskStarted(T1),
      turnAborted(T1),
      taskStarted(childTurn)
    )

  async function startChild(child: string): Promise<string> {
    const root = rollout('root', sessionMeta('0.169.0'), taskStarted(T1))
    await post({ turn_id: T1, transcript_path: root, hook_event_name: 'UserPromptSubmit' })
    await post({
      turn_id: 'child-turn',
      transcript_path: child,
      hook_event_name: 'SubagentStart',
      agent_id: CHILD_ID,
      agent_type: 'default'
    })
    await settle(1_000)
    expect(shown(row()).subagents).toEqual([['scout', 'working']])
    return root
  }

  it('ends a child whose turn errored', async () => {
    const child = childRollout('child-turn')
    const root = await startChild(child)
    appendFileSync(child, taskComplete('child-turn', { message: 'stream error' }))
    await post({ turn_id: T1, transcript_path: root, hook_event_name: 'Stop' })
    await settle()
    expect(shown(row())).toEqual({
      state: 'done',
      interrupted: false,
      outcome: undefined,
      subagents: []
    })
  })

  it('ends a child that interrupt_agent stopped', async () => {
    const child = childRollout('child-turn')
    const root = await startChild(child)
    await post({
      turn_id: T1,
      transcript_path: root,
      hook_event_name: 'PreToolUse',
      tool_name: 'collaborationinterrupt_agent'
    })
    appendFileSync(child, turnAborted('child-turn'))
    await post({ turn_id: T1, transcript_path: root, hook_event_name: 'Stop' })
    await settle()
    expect(shown(row())).toEqual({
      state: 'done',
      interrupted: false,
      outcome: undefined,
      subagents: []
    })
  })

  it('ends a child its parent recorded as interrupted (Codex before 0.150)', async () => {
    const child = childRollout('child-turn')
    const root = await startChild(child)
    appendFileSync(
      root,
      event({ type: 'sub_agent_activity', agent_thread_id: CHILD_ID, kind: 'interrupted' })
    )
    await post({ turn_id: T1, transcript_path: root, hook_event_name: 'Stop' })
    await settle()
    expect(shown(row()).subagents).toEqual([])
  })

  it('keeps a child whose ended turn a later hook shows resumed', async () => {
    const child = childRollout('child-turn')
    await startChild(child)
    const held = holdReads()
    appendFileSync(child, taskComplete('child-turn'))
    await vi.advanceTimersByTimeAsync(5_000)
    await held.captured
    // A follow-up reactivates the child after the read took its bytes.
    await post({
      transcript_path: child,
      hook_event_name: 'PreToolUse',
      agent_id: CHILD_ID,
      ...BASH
    })
    appendFileSync(child, taskStarted('child-turn-2'))
    held.releaseAll()
    await settle()
    expect(shown(row()).subagents).toEqual([['scout', 'working']])
  })

  it('keeps a child whose ended turn a later hook resumed before its rollout shows it', async () => {
    const child = childRollout('child-turn')
    await startChild(child)
    const held = holdReads(child)
    appendFileSync(child, taskComplete('child-turn'))
    await vi.advanceTimersByTimeAsync(5_000)
    await held.captured
    await post({
      transcript_path: child,
      hook_event_name: 'PreToolUse',
      agent_id: CHILD_ID,
      ...BASH
    })
    held.releaseAll()
    // The next read finds nothing new: Codex has not flushed the resumed turn yet.
    await settle(1_500)
    expect(shown(row()).subagents).toEqual([['scout', 'working']])
    appendFileSync(child, taskStarted('child-turn-2'))
    await settle()
    expect(shown(row()).subagents).toEqual([['scout', 'working']])
  })

  it('keeps a child whose aborted turn a follow-up replaced before any hook', async () => {
    const child = childRollout('child-turn')
    await startChild(child)
    const startedAt = row()?.subagents?.[0]?.startedAt
    appendFileSync(child, turnAborted('child-turn'))
    await settle(1_200)
    appendFileSync(child, taskStarted('child-turn-2'))
    await settle()
    expect(shown(row()).subagents).toEqual([['scout', 'working']])
    expect(row()?.subagents?.[0]?.startedAt).toBe(startedAt)
  })

  it('keeps a child working while only the root turn is cancelled', async () => {
    const child = childRollout('child-turn')
    const root = await startChild(child)
    await post({ turn_id: T1, transcript_path: root, hook_event_name: 'Interrupt' })
    await settle()
    expect(shown(row()).subagents).toEqual([['scout', 'working']])
    await post({
      transcript_path: root,
      agent_transcript_path: child,
      hook_event_name: 'SubagentStop',
      agent_id: CHILD_ID
    })
    expect(shown(row()).subagents).toEqual([])
  })

  it('retires a child that has neither a rollout nor hooks for a minute', async () => {
    const root = rollout('root', sessionMeta('0.169.0'), taskStarted(T1))
    await post({ turn_id: T1, transcript_path: root, hook_event_name: 'UserPromptSubmit' })
    await post({
      transcript_path: join(dir, 'rollout-missing-child.jsonl'),
      hook_event_name: 'SubagentStart',
      agent_id: CHILD_ID
    })
    await post({ turn_id: T1, transcript_path: root, hook_event_name: 'Stop' })
    await settle(30_000)
    expect(shown(row()).subagents).toHaveLength(1)
    await settle(40_000)
    expect(shown(row()).subagents).toEqual([])
  })

  it('ends, at the root Stop, a child whose hooks name no rollout of its own', async () => {
    const root = rollout('root', sessionMeta('0.169.0'), taskStarted(T1))
    await post({ turn_id: T1, transcript_path: root, hook_event_name: 'UserPromptSubmit' })
    await post({ transcript_path: root, hook_event_name: 'SubagentStart', agent_id: CHILD_ID })
    expect(shown(row()).subagents).toHaveLength(1)
    await post({ turn_id: T1, transcript_path: root, hook_event_name: 'Stop' })
    expect(shown(row()).subagents).toEqual([])
  })
})

describe('Codex rollout read ordering', () => {
  it('holds a user approval as working until a read that started after it lands', async () => {
    const held = holdReads()
    const root = rollout('root', taskStarted(T1), turnContext(T1, 'auto_review'))
    await post({ turn_id: T1, transcript_path: root, hook_event_name: 'UserPromptSubmit' })
    await held.captured
    // The reviewer changes after the prefetch read already has its bytes.
    appendFileSync(root, turnContext(T1, 'user'))
    await post({
      turn_id: T1,
      transcript_path: root,
      hook_event_name: 'PermissionRequest',
      ...BASH
    })
    expect(reads.inFlight.get(root)).toBe(1)
    expect(row()?.state).toBe('working')

    held.releaseAll()
    await vi.waitFor(() => expect(row()?.state).toBe('waiting'))
    expect(reads.maxInFlight).toBe(1)
  })

  it('shows a held approval once its read is overdue, so a hung read cannot hide it', async () => {
    reads.gate = () => new Promise(() => {})
    const root = rollout('root', taskStarted(T1), turnContext(T1, 'user'))
    await post({ turn_id: T1, transcript_path: root, hook_event_name: 'UserPromptSubmit' })
    await post({
      turn_id: T1,
      transcript_path: root,
      hook_event_name: 'PermissionRequest',
      ...BASH
    })
    await vi.advanceTimersByTimeAsync(4_900)
    expect(row()?.state).toBe('working')
    await vi.advanceTimersByTimeAsync(200)
    expect(row()?.state).toBe('waiting')
  })

  it('never keeps an overdue approval working on an earlier turn reviewer, and lets its late read correct it', async () => {
    const root = rollout('root', taskStarted(T1), turnContext(T1, 'auto_review'))
    await post({ turn_id: T1, transcript_path: root, hook_event_name: 'UserPromptSubmit' })
    await settle(500)
    await post({ turn_id: T1, transcript_path: root, hook_event_name: 'Stop' })

    const held = holdReads()
    appendFileSync(root, taskStarted(T2) + turnContext(T2, 'auto_review'))
    await post({ turn_id: T2, transcript_path: root, hook_event_name: 'UserPromptSubmit' })
    await post({
      turn_id: T2,
      transcript_path: root,
      hook_event_name: 'PermissionRequest',
      ...BASH
    })
    expect(row()?.state).toBe('working')
    await vi.advanceTimersByTimeAsync(5_100)
    expect(row()?.state).toBe('waiting')

    held.releaseAll()
    await settle()
    expect(row()?.state).toBe('working')
  })

  it('keeps a blocking question waiting when a late read finds the earlier approval auto-reviewed', async () => {
    const root = rollout('root', taskStarted(T1), turnContext(T1, 'auto_review'))
    const held = holdReads()
    await post({ turn_id: T1, transcript_path: root, hook_event_name: 'UserPromptSubmit' })
    await post({
      turn_id: T1,
      transcript_path: root,
      hook_event_name: 'PermissionRequest',
      ...BASH
    })
    await vi.advanceTimersByTimeAsync(5_100)
    expect(row()?.state).toBe('waiting')
    await post({
      turn_id: T1,
      transcript_path: root,
      hook_event_name: 'PreToolUse',
      tool_name: 'request_user_input',
      tool_input: { questions: [] },
      tool_use_id: 'call-2'
    })
    held.releaseAll()
    await settle()
    expect(row()?.state).toBe('waiting')
  })

  it('still shows Needs you when a parallel tool hook lands before the reviewer read', async () => {
    const held = holdReads()
    const root = rollout('root', taskStarted(T1), turnContext(T1, 'user'))
    await post({ turn_id: T1, transcript_path: root, hook_event_name: 'UserPromptSubmit' })
    await post({
      turn_id: T1,
      transcript_path: root,
      hook_event_name: 'PermissionRequest',
      ...BASH
    })
    const other = { tool_name: 'Read', tool_input: { path: 'a.txt' }, tool_use_id: 'call-2' }
    await post({ turn_id: T1, transcript_path: root, hook_event_name: 'PreToolUse', ...other })
    await post({ turn_id: T1, transcript_path: root, hook_event_name: 'PostToolUse', ...other })
    expect(row()?.state).toBe('working')
    held.releaseAll()
    await settle()
    expect(row()?.state).toBe('waiting')
  })

  it('drops a held approval once its own tool ran', async () => {
    const held = holdReads()
    const root = rollout('root', taskStarted(T1), turnContext(T1, 'user'))
    await post({ turn_id: T1, transcript_path: root, hook_event_name: 'UserPromptSubmit' })
    await post({
      turn_id: T1,
      transcript_path: root,
      hook_event_name: 'PermissionRequest',
      ...BASH
    })
    await post({ turn_id: T1, transcript_path: root, hook_event_name: 'PostToolUse', ...BASH })
    held.releaseAll()
    await settle()
    expect(row()?.state).toBe('working')
  })

  it('drops a held approval once its tool ran, though the request also named a justification', async () => {
    const held = holdReads()
    const root = rollout('root', taskStarted(T1), turnContext(T1, 'user'))
    await post({ turn_id: T1, transcript_path: root, hook_event_name: 'UserPromptSubmit' })
    await post({
      turn_id: T1,
      transcript_path: root,
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'rm x', description: 'needs escalation' }
    })
    await post({
      turn_id: T1,
      transcript_path: root,
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'rm x' },
      tool_use_id: 'call-1'
    })
    held.releaseAll()
    await settle()
    expect(row()?.state).toBe('working')
  })

  it('carries a held approval to the pane it moves to', async () => {
    const target = GOOD_PANE
    const held = holdReads()
    const root = rollout('root', taskStarted(T1), turnContext(T1, 'user'))
    await post({ turn_id: T1, transcript_path: root, hook_event_name: 'UserPromptSubmit' })
    await post({
      turn_id: T1,
      transcript_path: root,
      hook_event_name: 'PermissionRequest',
      ...BASH
    })
    server.transferPaneAuthority(PANE, target, 'pty-1')
    expect(row(target)?.state).toBe('working')
    held.releaseAll()
    await settle()
    expect(row(target)?.state).toBe('waiting')
  })

  it('ends a /review turn on the pane it moved to when no hook follows', async () => {
    const target = GOOD_PANE
    const review = rollout('review', taskStarted(T1))
    await post({ turn_id: T1, transcript_path: review, hook_event_name: 'UserPromptSubmit' })
    await post({ turn_id: T1, transcript_path: review, hook_event_name: 'PreToolUse', ...BASH })
    await settle(1_000)
    server.transferPaneAuthority(PANE, target, 'pty-1')
    appendFileSync(review, taskComplete(T1))
    await settle()
    expect(shown(row(target))).toEqual({
      state: 'done',
      interrupted: false,
      outcome: undefined,
      subagents: []
    })
  })

  it('drops a pre-0.150 abort read that lands after Stop and the next prompt', async () => {
    const held = holdReads()
    const root = rollout('root', sessionMeta('0.146.0'), taskStarted(T1), turnAborted(T1))
    await post({ turn_id: T1, transcript_path: root, hook_event_name: 'UserPromptSubmit' })
    await held.captured
    await post({ turn_id: T1, transcript_path: root, hook_event_name: 'Stop' })
    await post({ turn_id: T2, transcript_path: root, hook_event_name: 'UserPromptSubmit' })
    held.releaseAll()
    await settle()
    expect(shown(row())).toEqual({
      state: 'working',
      interrupted: false,
      outcome: undefined,
      subagents: []
    })
  })

  it('re-reads, in the new turn, an abort read that started before the turn moved on', async () => {
    const held = holdReads()
    const root = rollout('root', sessionMeta('0.146.0'), taskStarted(T1), turnAborted(T1))
    // Hooks without turn ids leave only read order to tell the two turns apart.
    await post({ transcript_path: root, hook_event_name: 'UserPromptSubmit' })
    await held.captured
    await post({ transcript_path: root, hook_event_name: 'Stop' })
    // Codex writes a turn's task_started before its UserPromptSubmit hook runs.
    appendFileSync(root, taskStarted(T2))
    await post({ transcript_path: root, hook_event_name: 'UserPromptSubmit' })
    held.releaseAll()
    await settle()
    expect(shown(row())).toEqual({
      state: 'working',
      interrupted: false,
      outcome: undefined,
      subagents: []
    })
  })

  it('drops a child name read once the child has finished', async () => {
    const held = holdReads()
    const root = rollout('root', taskStarted(T1))
    const child = rollout('child', childMeta(CHILD_ID, '/root/scout'))
    await post({ turn_id: T1, transcript_path: root, hook_event_name: 'UserPromptSubmit' })
    await post({ transcript_path: child, hook_event_name: 'SubagentStart', agent_id: CHILD_ID })
    await held.captured
    await post({ transcript_path: root, hook_event_name: 'SubagentStop', agent_id: CHILD_ID })
    held.releaseAll()
    await settle()
    expect(shown(row()).subagents).toEqual([])
  })
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

/** Hold each read result back 0-2 s of fake time, which settle() advances. */
function delayEachRead(random: () => number): () => Promise<void> {
  // ast-grep-ignore: test-no-real-time-wait -- runs on fake timers that settle() drives
  return () => new Promise((resolve) => setTimeout(resolve, random() * 2_000))
}

type Scenario = { name: string; run: () => Promise<void>; expected: Record<string, unknown> }

const SCENARIOS: Scenario[] = [
  {
    name: 'subagents still running',
    run: async () => {
      const root = rollout('root', sessionMeta('0.169.0'), taskStarted(T1))
      const child = rollout('child', childMeta(CHILD_ID, '/root/scout'))
      const grandchild = rollout('grandchild', childMeta(GRANDCHILD_ID, '/root/scout/deep'))
      await post({ turn_id: T1, transcript_path: root, hook_event_name: 'UserPromptSubmit' })
      await post({ transcript_path: child, hook_event_name: 'SubagentStart', agent_id: CHILD_ID })
      await post({
        transcript_path: grandchild,
        hook_event_name: 'SubagentStart',
        agent_id: GRANDCHILD_ID
      })
      await post({
        transcript_path: grandchild,
        hook_event_name: 'PreToolUse',
        agent_id: GRANDCHILD_ID,
        ...BASH
      })
    },
    expected: {
      state: 'working',
      interrupted: false,
      outcome: undefined,
      subagents: [
        ['scout', 'working'],
        ['scout/deep', 'working']
      ]
    }
  },
  {
    name: 'user approval',
    run: async () => {
      const root = rollout('root', taskStarted(T1), turnContext(T1, 'user'))
      await post({ turn_id: T1, transcript_path: root, hook_event_name: 'UserPromptSubmit' })
      await post({ turn_id: T1, transcript_path: root, hook_event_name: 'PreToolUse', ...BASH })
      await post({
        turn_id: T1,
        transcript_path: root,
        hook_event_name: 'PermissionRequest',
        ...BASH
      })
    },
    expected: { state: 'waiting', interrupted: false, outcome: undefined, subagents: [] }
  },
  {
    name: 'auto-reviewed approval',
    run: async () => {
      const root = rollout('root', taskStarted(T1), turnContext(T1, 'auto_review'))
      await post({ turn_id: T1, transcript_path: root, hook_event_name: 'UserPromptSubmit' })
      await post({ turn_id: T1, transcript_path: root, hook_event_name: 'PreToolUse', ...BASH })
      await post({
        turn_id: T1,
        transcript_path: root,
        hook_event_name: 'PermissionRequest',
        ...BASH
      })
    },
    expected: { state: 'working', interrupted: false, outcome: undefined, subagents: [] }
  },
  {
    name: 'failed turn',
    run: async () => {
      const root = rollout('root', taskStarted(T1))
      await post({ turn_id: T1, transcript_path: root, hook_event_name: 'UserPromptSubmit' })
      appendFileSync(root, taskComplete(T1, { message: 'model_not_found' }))
    },
    expected: { state: 'done', interrupted: false, outcome: 'failure', subagents: [] }
  },
  {
    name: '/review',
    run: async () => {
      const review = rollout('review', taskStarted(T1))
      await post({ turn_id: T1, transcript_path: review, hook_event_name: 'UserPromptSubmit' })
      await post({ turn_id: T1, transcript_path: review, hook_event_name: 'PreToolUse', ...BASH })
      await post({ turn_id: T1, transcript_path: review, hook_event_name: 'PostToolUse', ...BASH })
      appendFileSync(review, taskComplete(T1))
    },
    expected: { state: 'done', interrupted: false, outcome: undefined, subagents: [] }
  },
  {
    name: 'pre-0.150 cancel, then a new prompt',
    run: async () => {
      const root = rollout('root', sessionMeta('0.146.0'), taskStarted(T1))
      await post({ turn_id: T1, transcript_path: root, hook_event_name: 'UserPromptSubmit' })
      await post({ turn_id: T1, transcript_path: root, hook_event_name: 'PreToolUse', ...BASH })
      appendFileSync(root, turnAborted(T1))
      await post({ turn_id: T2, transcript_path: root, hook_event_name: 'UserPromptSubmit' })
      appendFileSync(root, taskStarted(T2))
      await post({ turn_id: T2, transcript_path: root, hook_event_name: 'PreToolUse', ...BASH })
    },
    expected: { state: 'working', interrupted: false, outcome: undefined, subagents: [] }
  },
  {
    name: 'cancel, then a Ctrl+C copy turn',
    run: async () => {
      const root = rollout('root', sessionMeta('0.169.0'), taskStarted(T1))
      await post({ turn_id: T1, transcript_path: root, hook_event_name: 'UserPromptSubmit' })
      appendFileSync(root, turnAborted(T1))
      await post({ turn_id: T1, transcript_path: root, hook_event_name: 'Interrupt' })
      await post({ turn_id: T2, transcript_path: root, hook_event_name: 'UserPromptSubmit' })
      appendFileSync(root, taskStarted(T2))
      await post({ turn_id: T2, transcript_path: root, hook_event_name: 'PreToolUse', ...BASH })
      appendFileSync(root, taskComplete(T2))
      await post({ turn_id: T2, transcript_path: root, hook_event_name: 'Stop' })
    },
    expected: { state: 'done', interrupted: false, outcome: undefined, subagents: [] }
  }
]

describe('Codex rollout reads under random delays', () => {
  for (const scenario of SCENARIOS) {
    it(`ends "${scenario.name}" the same however late each read lands`, async () => {
      for (let seed = 1; seed <= 12; seed += 1) {
        const random = seed === 1 ? () => 0 : mulberry32(seed)
        reads.gate = delayEachRead(random)
        await scenario.run()
        await settle()
        expect({ seed, ...shown(row()) }).toEqual({ seed, ...scenario.expected })
        if (scenario.name === 'auto-reviewed approval') {
          expect(published.some((entry) => entry.state === 'waiting')).toBe(false)
        }
        server.stop()
        _internals.resetCachesForTests()
        await startServer()
      }
    })
  }
})

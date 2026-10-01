import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AgentHookServer } from './server'
import { makePaneKey } from '../../shared/stable-pane-id'

const PANE_KEY = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')
const CHILD_ID = '019fa65f-3144-7151-9c02-cff7a28f316f'
// Longer than one transcript poll, so "still working" means the poll ran and declined.
const POLL_SETTLE_MS = 1_500

function line(record: unknown): string {
  return `${JSON.stringify(record)}\n`
}

function taskStarted(turnId: string): string {
  return line({ type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } })
}

// Shape Codex 0.156 writes when a turn ends; `error` is present only when the turn failed.
function taskComplete(turnId: string, failed: boolean): string {
  return line({
    type: 'event_msg',
    payload: {
      type: 'task_complete',
      turn_id: turnId,
      last_agent_message: null,
      ...(failed
        ? {
            error: {
              message:
                'We’re currently experiencing high demand, which may cause temporary errors.',
              codex_error_info: 'internal_server_error'
            }
          }
        : {})
    }
  })
}

describe('AgentHookServer settles a Codex turn from its rollout', () => {
  const dirs: string[] = []
  const servers: AgentHookServer[] = []

  afterEach(() => {
    for (const server of servers) {
      server.stop()
    }
    servers.length = 0
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true })
    }
    dirs.length = 0
  })

  async function startRig(initialRollout = ''): Promise<{
    rollout: string
    dir: string
    server: AgentHookServer
    post: (payload: Record<string, unknown>) => Promise<Response>
    row: () => ReturnType<AgentHookServer['getStatusSnapshot']>[number] | undefined
  }> {
    const dir = mkdtempSync(join(tmpdir(), 'agent-hook-codex-turn-end-'))
    dirs.push(dir)
    const rollout = join(dir, 'rollout-parent.jsonl')
    writeFileSync(rollout, initialRollout)
    const server = new AgentHookServer()
    servers.push(server)
    await server.start({ env: 'production' })
    const env = server.buildPtyEnv()
    const post = (payload: Record<string, unknown>): Promise<Response> =>
      fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/codex`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
        },
        body: JSON.stringify({
          paneKey: PANE_KEY,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          payload: { session_id: 'root-session', transcript_path: rollout, ...payload }
        })
      })
    return { rollout, dir, server, post, row: () => server.getStatusSnapshot()[0] }
  }

  async function startFailingTurn(
    rig: Awaited<ReturnType<typeof startRig>>,
    turnId: string
  ): Promise<void> {
    appendFileSync(rig.rollout, taskStarted(turnId))
    await rig.post({ hook_event_name: 'UserPromptSubmit', turn_id: turnId, prompt: 'run it' })
    await rig.post({ hook_event_name: 'PreToolUse', turn_id: turnId, tool_name: 'Bash' })
    await rig.post({ hook_event_name: 'PostToolUse', turn_id: turnId, tool_name: 'Bash' })
    expect(rig.row()).toMatchObject({ state: 'working', mainAgent: { state: 'working' } })
  }

  // STA-7949: Codex runs no hook at all when a turn fails, so nothing but the rollout ends it.
  it('settles a turn that failed after a tool call, with no Stop hook', async () => {
    const rig = await startRig()
    await startFailingTurn(rig, 'turn-1')

    appendFileSync(rig.rollout, taskComplete('turn-1', true))

    await vi.waitFor(
      () => {
        expect(rig.row()).toMatchObject({
          state: 'done',
          prompt: 'run it',
          mainAgent: { state: 'done', outcome: 'failure' }
        })
      },
      { timeout: 3_000, interval: 50 }
    )
  })

  it('settles a turn the rollout completed without an outcome when its Stop never arrived', async () => {
    const rig = await startRig()
    await startFailingTurn(rig, 'turn-1')

    appendFileSync(rig.rollout, taskComplete('turn-1', false))

    await vi.waitFor(
      () => {
        expect(rig.row()).toMatchObject({ state: 'done', mainAgent: { state: 'done' } })
      },
      { timeout: 3_000, interval: 50 }
    )
    expect(rig.row()?.mainAgent?.outcome).toBeUndefined()
  })

  it('never settles the open turn from an earlier turn’s end', async () => {
    const rig = await startRig(taskStarted('turn-0') + taskComplete('turn-0', true))
    await startFailingTurn(rig, 'turn-1')

    await new Promise((resolve) => setTimeout(resolve, POLL_SETTLE_MS))
    expect(rig.row()).toMatchObject({ state: 'working', mainAgent: { state: 'working' } })
  })

  it('keeps a new prompt working when it lands before the poll reads the old turn’s end', async () => {
    const rig = await startRig()
    await startFailingTurn(rig, 'turn-1')

    appendFileSync(rig.rollout, taskComplete('turn-1', true) + taskStarted('turn-2'))
    await rig.post({ hook_event_name: 'UserPromptSubmit', turn_id: 'turn-2', prompt: 'again' })

    await new Promise((resolve) => setTimeout(resolve, POLL_SETTLE_MS))
    expect(rig.row()).toMatchObject({
      state: 'working',
      prompt: 'again',
      mainAgent: { state: 'working' }
    })

    appendFileSync(rig.rollout, taskComplete('turn-2', false))
    await vi.waitFor(
      () => {
        expect(rig.row()).toMatchObject({ state: 'done', prompt: 'again' })
      },
      { timeout: 3_000, interval: 50 }
    )
  })

  it('treats a late Stop for the settled turn as a restatement, not a new transition', async () => {
    const rig = await startRig()
    await startFailingTurn(rig, 'turn-1')
    appendFileSync(rig.rollout, taskComplete('turn-1', true))
    await vi.waitFor(
      () => {
        expect(rig.row()?.state).toBe('done')
      },
      { timeout: 3_000, interval: 50 }
    )
    const settled = rig.row()

    await rig.post({ hook_event_name: 'Stop', turn_id: 'turn-1' })

    expect(rig.row()).toMatchObject({
      state: 'done',
      stateStartedAt: settled?.stateStartedAt,
      mainAgent: {
        state: 'done',
        outcome: 'failure',
        stateStartedAt: settled?.mainAgent?.stateStartedAt
      }
    })
  })

  it('leaves the turn working when its rollout cannot be read', async () => {
    const rig = await startRig()
    const missing = join(rig.dir, 'rollout-missing.jsonl')
    await rig.post({
      hook_event_name: 'UserPromptSubmit',
      turn_id: 'turn-1',
      prompt: 'run it',
      transcript_path: missing
    })
    await rig.post({
      hook_event_name: 'PostToolUse',
      turn_id: 'turn-1',
      tool_name: 'Bash',
      transcript_path: missing
    })

    await new Promise((resolve) => setTimeout(resolve, POLL_SETTLE_MS))
    expect(rig.row()).toMatchObject({ state: 'working', mainAgent: { state: 'working' } })
  })

  it('ends the root turn but keeps the row working while a child still runs', async () => {
    const rig = await startRig(
      line({
        type: 'event_msg',
        payload: {
          type: 'sub_agent_activity',
          occurred_at_ms: 1234,
          agent_thread_id: CHILD_ID,
          agent_path: '/root/pr_review',
          kind: 'started'
        }
      })
    )
    const childRollout = join(rig.dir, `rollout-child-${CHILD_ID}.jsonl`)
    writeFileSync(childRollout, taskStarted('child-turn'))
    await startFailingTurn(rig, 'turn-1')
    expect(rig.row()?.subagents).toHaveLength(1)

    appendFileSync(rig.rollout, taskComplete('turn-1', true))
    await vi.waitFor(
      () => {
        expect(rig.row()).toMatchObject({
          state: 'working',
          mainAgent: { state: 'done', outcome: 'failure' }
        })
      },
      { timeout: 3_000, interval: 50 }
    )

    appendFileSync(childRollout, taskComplete('child-turn', false))
    await vi.waitFor(
      () => {
        expect(rig.row()).toMatchObject({ state: 'done', mainAgent: { state: 'done' } })
      },
      { timeout: 3_000, interval: 50 }
    )
  })

  // A hook-reported child keeps posting its own hooks while the root turn fails, so the root fires none after.
  it('settles the root turn when a child hook, not a root hook, is the latest event', async () => {
    const rig = await startRig()
    await startFailingTurn(rig, 'turn-1')
    const childRollout = join(rig.dir, 'rollout-child.jsonl')
    writeFileSync(childRollout, '')
    const child = {
      agent_id: 'child-1',
      agent_type: 'worker',
      turn_id: 'child-turn',
      transcript_path: childRollout
    }
    await rig.post({ hook_event_name: 'SubagentStart', ...child })
    await rig.post({ hook_event_name: 'PostToolUse', tool_name: 'Bash', ...child })

    appendFileSync(rig.rollout, taskComplete('turn-1', true))
    await vi.waitFor(
      () => {
        expect(rig.row()).toMatchObject({
          state: 'working',
          mainAgent: { state: 'done', outcome: 'failure' }
        })
      },
      { timeout: 3_000, interval: 50 }
    )

    await rig.post({ hook_event_name: 'SubagentStop', ...child })
    expect(rig.row()).toMatchObject({
      state: 'done',
      mainAgent: { state: 'done', outcome: 'failure' }
    })
  })

  it('settles the root turn when a finished child’s SubagentStop is the latest event', async () => {
    const rig = await startRig()
    await startFailingTurn(rig, 'turn-1')
    const child = { agent_id: 'child-1', agent_type: 'worker', turn_id: 'child-turn' }
    await rig.post({ hook_event_name: 'SubagentStart', ...child })
    await rig.post({ hook_event_name: 'SubagentStop', ...child })

    appendFileSync(rig.rollout, taskComplete('turn-1', true))
    await vi.waitFor(
      () => {
        expect(rig.row()).toMatchObject({
          state: 'done',
          mainAgent: { state: 'done', outcome: 'failure' }
        })
      },
      { timeout: 3_000, interval: 50 }
    )
  })

  // Codex fires SessionStart(compact) mid-turn with no turn_id, then the turn can fail with no further hook.
  it('settles a turn that failed after a mid-turn compaction', async () => {
    const rig = await startRig()
    await startFailingTurn(rig, 'turn-1')
    await rig.post({ hook_event_name: 'SessionStart', source: 'compact', model: 'gpt-5.5' })

    appendFileSync(rig.rollout, taskComplete('turn-1', true))

    await vi.waitFor(
      () => {
        expect(rig.row()).toMatchObject({
          state: 'done',
          mainAgent: { state: 'done', outcome: 'failure' }
        })
      },
      { timeout: 3_000, interval: 50 }
    )
  })
})

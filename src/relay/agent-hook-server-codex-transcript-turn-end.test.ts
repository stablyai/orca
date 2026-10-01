import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { RelayAgentHookServer } from './agent-hook-server'
import type { AgentHookRelayEnvelope } from '../shared/agent-hook-relay'
import { makePaneKey } from '../shared/stable-pane-id'
import { AgentHookServer } from '../main/agent-hooks/server'

const PANE_KEY = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')
const CHILD_ID = '019fa65f-3144-7151-9c02-cff7a28f316f'

function line(record: unknown): string {
  return `${JSON.stringify(record)}\n`
}

function taskComplete(turnId: string, failed: boolean): string {
  return line({
    type: 'event_msg',
    payload: {
      type: 'task_complete',
      turn_id: turnId,
      ...(failed ? { error: { message: 'upstream failure' } } : {})
    }
  })
}

describe('RelayAgentHookServer settles a Codex turn from its rollout', () => {
  const dirs: string[] = []
  const stops: (() => void)[] = []

  afterEach(() => {
    for (const stop of stops) {
      stop()
    }
    stops.length = 0
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true })
    }
    dirs.length = 0
  })

  /** A real relay whose forwards feed a real desktop hook server, as over SSH. */
  async function startRelayToDesktop(initialRollout: string): Promise<{
    dir: string
    rollout: string
    post: (payload: Record<string, unknown>) => Promise<Response>
    desktopRow: () => ReturnType<AgentHookServer['getStatusSnapshot']>[number] | undefined
  }> {
    const dir = mkdtempSync(join(tmpdir(), 'relay-hook-codex-turn-end-'))
    dirs.push(dir)
    const rollout = join(dir, 'rollout-parent.jsonl')
    writeFileSync(rollout, initialRollout)
    const desktop = new AgentHookServer()
    const relay = new RelayAgentHookServer({
      endpointDir: dir,
      forward: (envelope) => desktop.ingestRemote(envelope, 'conn-test')
    })
    stops.push(
      () => relay.stop(),
      () => desktop.stop()
    )
    await relay.start()
    const { port, token } = relay.getCoordinates()
    const post = (payload: Record<string, unknown>): Promise<Response> =>
      fetch(`http://127.0.0.1:${port}/hook/codex`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Orca-Agent-Hook-Token': token },
        body: JSON.stringify({
          paneKey: PANE_KEY,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          payload: { session_id: 'root-session', transcript_path: rollout, ...payload }
        })
      })
    return { dir, rollout, post, desktopRow: () => desktop.getStatusSnapshot()[0] }
  }

  // STA-7949: only the execution host can read the rollout, so the relay must publish the turn end itself.
  it('forwards a failed turn as a Stop carrying the failure, then stops polling', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-hook-codex-turn-end-'))
    dirs.push(dir)
    const rollout = join(dir, 'rollout-parent.jsonl')
    writeFileSync(
      rollout,
      line({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } })
    )
    const forward = vi.fn<(envelope: AgentHookRelayEnvelope) => void>()
    const server = new RelayAgentHookServer({ endpointDir: dir, forward })
    await server.start()
    try {
      const { port, token } = server.getCoordinates()
      const post = (payload: Record<string, unknown>): Promise<Response> =>
        fetch(`http://127.0.0.1:${port}/hook/codex`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Orca-Agent-Hook-Token': token },
          body: JSON.stringify({
            paneKey: PANE_KEY,
            tabId: 'tab-1',
            worktreeId: 'wt-1',
            payload: {
              session_id: 'root-session',
              transcript_path: rollout,
              turn_id: 'turn-1',
              ...payload
            }
          })
        })
      await post({ hook_event_name: 'UserPromptSubmit', prompt: 'run it' })
      await post({ hook_event_name: 'PostToolUse', tool_name: 'Bash' })
      expect(forward.mock.calls.at(-1)?.[0]).toMatchObject({
        hookEventName: 'PostToolUse',
        payload: { state: 'working' }
      })
      const forwardsBeforeEnd = forward.mock.calls.length

      appendFileSync(
        rollout,
        line({
          type: 'event_msg',
          payload: {
            type: 'task_complete',
            turn_id: 'turn-1',
            error: { message: 'upstream failure', codex_error_info: 'internal_server_error' }
          }
        })
      )

      await vi.waitFor(
        () => {
          expect(forward.mock.calls.at(-1)?.[0]).toMatchObject({
            hookEventName: 'Stop',
            payload: { state: 'done', mainAgent: { state: 'done', outcome: 'failure' } }
          })
        },
        { timeout: 3_000, interval: 50 }
      )
      expect(forward).toHaveBeenCalledTimes(forwardsBeforeEnd + 1)
      await new Promise((resolve) => setTimeout(resolve, 1_500))
      expect(forward).toHaveBeenCalledTimes(forwardsBeforeEnd + 1)
    } finally {
      server.stop()
    }
  })

  // The relay publishes later child-only updates too; each must keep the desktop's root done.
  it('keeps the desktop row settled when a child outlives the failed root turn', async () => {
    const rig = await startRelayToDesktop(
      line({
        type: 'event_msg',
        payload: {
          type: 'sub_agent_activity',
          occurred_at_ms: 1234,
          agent_thread_id: CHILD_ID,
          agent_path: '/root/worker',
          kind: 'started'
        }
      })
    )
    const childRollout = join(rig.dir, `rollout-child-${CHILD_ID}.jsonl`)
    writeFileSync(
      childRollout,
      line({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'child-turn' } })
    )
    await rig.post({ hook_event_name: 'UserPromptSubmit', turn_id: 'turn-1', prompt: 'run it' })
    await rig.post({ hook_event_name: 'PostToolUse', turn_id: 'turn-1', tool_name: 'Bash' })

    appendFileSync(rig.rollout, taskComplete('turn-1', true))
    await vi.waitFor(
      () => {
        expect(rig.desktopRow()).toMatchObject({
          state: 'working',
          mainAgent: { state: 'done', outcome: 'failure' }
        })
      },
      { timeout: 3_000, interval: 50 }
    )

    appendFileSync(childRollout, taskComplete('child-turn', false))
    await vi.waitFor(
      () => {
        expect(rig.desktopRow()).toMatchObject({
          state: 'done',
          mainAgent: { state: 'done', outcome: 'failure' }
        })
      },
      { timeout: 3_000, interval: 50 }
    )
  })

  it('settles the desktop row when the root turn ends under a hook-reported child', async () => {
    const rig = await startRelayToDesktop('')
    const child = {
      agent_id: 'child-1',
      agent_type: 'worker',
      turn_id: 'child-turn',
      transcript_path: join(rig.dir, 'rollout-child.jsonl')
    }
    await rig.post({ hook_event_name: 'UserPromptSubmit', turn_id: 'turn-1', prompt: 'run it' })
    await rig.post({ hook_event_name: 'SubagentStart', ...child })
    await rig.post({ hook_event_name: 'PostToolUse', tool_name: 'Bash', ...child })

    appendFileSync(rig.rollout, taskComplete('turn-1', true))
    await vi.waitFor(
      () => {
        expect(rig.desktopRow()).toMatchObject({
          state: 'working',
          mainAgent: { state: 'done', outcome: 'failure' }
        })
      },
      { timeout: 3_000, interval: 50 }
    )

    await rig.post({ hook_event_name: 'SubagentStop', ...child })
    expect(rig.desktopRow()).toMatchObject({
      state: 'done',
      mainAgent: { state: 'done', outcome: 'failure' }
    })
  })
})

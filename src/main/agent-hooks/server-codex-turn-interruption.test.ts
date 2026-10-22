import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentHookServer } from './server'
import { PANE } from './server.test-fixtures'

const line = (payload: unknown): string => `${JSON.stringify({ type: 'event_msg', payload })}\n`

describe('Codex recorded turn interruption', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true })
    }
    dirs.length = 0
  })

  it.each([false, true])('settles the lead and preserves child work: %s', async (withChild) => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-turn-interruption-'))
    dirs.push(dir)
    const transcriptPath = join(dir, 'rollout-root.jsonl')
    const childPath = join(dir, 'rollout-child-child-1.jsonl')
    writeFileSync(transcriptPath, line({ type: 'task_started', turn_id: 'turn-1' }))
    if (withChild) {
      appendFileSync(
        transcriptPath,
        line({
          type: 'sub_agent_activity',
          agent_thread_id: 'child-1',
          kind: 'started',
          agent_path: '/root/child',
          occurred_at_ms: Date.now()
        })
      )
      writeFileSync(childPath, line({ type: 'task_started' }))
    }
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const env = server.buildPtyEnv()
      const response = await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/codex`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
        },
        body: JSON.stringify({
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'folder-1',
          payload: {
            hook_event_name: 'UserPromptSubmit',
            session_id: 'main-session',
            prompt: 'main task',
            transcript_path: transcriptPath
          }
        })
      })
      expect(response.status).toBe(204)
      const beforeSide = server.getStatusSnapshot()[0]
      for (const hookEventName of ['SessionStart', 'UserPromptSubmit', 'Stop']) {
        const sideResponse = await fetch(
          `http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/codex`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
            },
            body: JSON.stringify({
              paneKey: PANE,
              tabId: 'tab-1',
              worktreeId: 'folder-1',
              payload: {
                hook_event_name: hookEventName,
                session_id: 'side-session',
                transcript_path: null,
                prompt: 'side chat'
              }
            })
          }
        )
        expect(sideResponse.status).toBe(204)
        expect(server.getStatusSnapshot()[0]).toEqual(beforeSide)
      }
      const baseline = server.getStatusSnapshot()[0]
      for (const intent of ['ctrl-c', 'plain-escape'] as const) {
        for (const inputCount of [1, 2]) {
          expect(
            server.inferInterrupt({
              paneKey: PANE,
              baselineUpdatedAt: baseline.receivedAt,
              baselineStateStartedAt: baseline.stateStartedAt,
              baselinePrompt: baseline.prompt,
              baselineAgentType: 'codex',
              intent,
              inputCount
            })
          ).toBe(false)
          expect(server.getStatusSnapshot()[0]).toEqual(baseline)
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 600))
      expect(server.getStatusSnapshot()[0].state).toBe('working')
      appendFileSync(
        transcriptPath,
        line({ type: 'turn_aborted', turn_id: 'turn-1', reason: 'interrupted' })
      )
      await vi.waitFor(
        () => {
          expect(server.getStatusSnapshot()[0]).toMatchObject({
            state: withChild ? 'working' : 'done',
            mainAgent: { state: 'done', outcome: 'cancellation' }
          })
        },
        { timeout: 2_000 }
      )
      if (withChild) {
        expect(server.getStatusSnapshot()[0].interrupted).toBeUndefined()
        appendFileSync(childPath, line({ type: 'task_complete' }))
        await vi.waitFor(
          () =>
            expect(server.getStatusSnapshot()[0]).toMatchObject({
              state: 'done',
              interrupted: true,
              mainAgent: { state: 'done', outcome: 'cancellation' }
            }),
          { timeout: 2_000 }
        )
      } else {
        expect(server.getStatusSnapshot()[0].interrupted).toBe(true)
      }
    } finally {
      server.stop()
    }
  })
})

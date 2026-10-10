import { expect, it, vi } from 'vitest'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentHookRelayEnvelope } from '../shared/agent-hook-relay'
import { RelayAgentHookServer } from './agent-hook-server'
import { AgentHookServer } from '../main/agent-hooks/server'

const PANE_KEY = 'tab-1:11111111-1111-4111-8111-111111111111'
const line = (payload: unknown): string => `${JSON.stringify({ type: 'event_msg', payload })}\n`

it('forwards host-confirmed Codex interruption without requiring a local rollout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-codex-interruption-'))
  const transcriptPath = join(dir, 'rollout-root.jsonl')
  writeFileSync(transcriptPath, line({ type: 'task_started', turn_id: 'turn-1' }))
  const desktop = new AgentHookServer()
  const forward = vi.fn((envelope: AgentHookRelayEnvelope) =>
    desktop.ingestRemote(envelope, 'ssh-connection')
  )
  const server = new RelayAgentHookServer({ endpointDir: dir, forward })
  await server.start()
  try {
    const { port, token } = server.getCoordinates()
    const response = await fetch(`http://127.0.0.1:${port}/hook/codex`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Orca-Agent-Hook-Token': token },
      body: JSON.stringify({
        paneKey: PANE_KEY,
        tabId: 'tab-1',
        worktreeId: 'folder-1',
        payload: {
          hook_event_name: 'UserPromptSubmit',
          session_id: 'main-session',
          prompt: 'remote main task',
          transcript_path: transcriptPath
        }
      })
    })
    expect(response.status).toBe(204)
    expect(desktop.getStatusSnapshot()[0].state).toBe('working')
    const sideResponse = await fetch(`http://127.0.0.1:${port}/hook/codex`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Orca-Agent-Hook-Token': token },
      body: JSON.stringify({
        paneKey: PANE_KEY,
        tabId: 'tab-1',
        worktreeId: 'folder-1',
        payload: {
          hook_event_name: 'UserPromptSubmit',
          session_id: 'side-session',
          transcript_path: null,
          prompt: 'side chat'
        }
      })
    })
    expect(sideResponse.status).toBe(204)
    expect(forward).toHaveBeenCalledTimes(1)

    const baseline = desktop.getStatusSnapshot()[0]
    for (const inputCount of [1, 2]) {
      expect(
        desktop.inferInterrupt({
          paneKey: PANE_KEY,
          baselineUpdatedAt: baseline.receivedAt,
          baselineStateStartedAt: baseline.stateStartedAt,
          baselinePrompt: baseline.prompt,
          baselineAgentType: 'codex',
          intent: 'plain-escape',
          inputCount
        })
      ).toBe(false)
      expect(desktop.getStatusSnapshot()[0]).toEqual(baseline)
    }

    appendFileSync(
      transcriptPath,
      line({ type: 'turn_aborted', turn_id: 'turn-1', reason: 'interrupted' })
    )
    await vi.waitFor(
      () =>
        expect(desktop.getStatusSnapshot()[0]).toMatchObject({
          connectionId: 'ssh-connection',
          state: 'done',
          interrupted: true,
          mainAgent: { state: 'done', outcome: 'cancellation' }
        }),
      { timeout: 2_000 }
    )
    expect(forward.mock.calls.at(-1)?.[0].hookEventName).toBeUndefined()
    expect(forward).toHaveBeenCalledTimes(2)
  } finally {
    server.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

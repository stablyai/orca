import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AgentHookServer } from './server'
import type { EnrichedAgentHookEventPayload } from './server/server-types'
import { makePaneKey } from '../../shared/stable-pane-id'

const PANE_KEY = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')
const SESSION_ID = '01a0caa3-0e77-7d41-bad7-46283a45633d'
const PROMPT_ID = '01a0caa3-a25a-7810-8229-4de04b2e7ca3'
const QUESTION = { id: 'fav_color', question: 'What is your favorite color?' }

function sessionLogLine(event: Record<string, unknown>): string {
  return `${JSON.stringify({ payload: { kind: 'run', event } })}\n`
}

function createSessionLog(dataHome: string): string {
  const date = new Date(Number.parseInt(SESSION_ID.replace(/-/g, '').slice(0, 12), 16))
  const dir = join(
    dataHome,
    'muse',
    'sessions',
    String(date.getFullYear()),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
    SESSION_ID
  )
  mkdirSync(dir, { recursive: true })
  const logPath = join(dir, 'session.jsonl')
  writeFileSync(logPath, '')
  return logPath
}

describe('AgentHookServer Muse session log polling', () => {
  const dirs: string[] = []

  afterEach(() => {
    vi.unstubAllEnvs()
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true })
    }
    dirs.length = 0
  })

  // Why: Muse fires no hook for request_user_input, so only the poll can surface the wait and its answer.
  it('flips the pane to waiting for a logged question and back once it settles', async () => {
    const dataHome = mkdtempSync(join(tmpdir(), 'agent-hook-muse-poll-'))
    dirs.push(dataHome)
    vi.stubEnv('XDG_DATA_HOME', dataHome)
    const logPath = createSessionLog(dataHome)
    const server = new AgentHookServer()
    const published: EnrichedAgentHookEventPayload[] = []
    server.setListener((event) => published.push(event))
    await server.start({ env: 'production' })
    try {
      const env = server.buildPtyEnv()
      const response = await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/muse`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
        },
        body: JSON.stringify({
          paneKey: PANE_KEY,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          payload: {
            hook_event_name: 'UserPromptSubmit',
            prompt: 'ask my favorite color',
            session_id: SESSION_ID,
            turn_id: 'e495d1a5-59aa-47b4-8efb-a1bd75509afc',
            cwd: '/tmp/ws',
            transcript_path: null,
            model: 'muse-spark-1.3',
            permission_mode: 'default',
            model_provider: 'meta'
          }
        })
      })
      expect(response.status).toBe(204)
      expect(server.getStatusSnapshot()[0]?.state).toBe('working')
      expect(published.at(-1)?.hasExplicitPrompt).toBe(true)

      appendFileSync(
        logPath,
        sessionLogLine({
          kind: 'user_input_prompt_requested',
          prompt_id: PROMPT_ID,
          tool_name: 'request_user_input',
          questions: [QUESTION]
        })
      )
      await vi.waitFor(
        () => {
          expect(server.getStatusSnapshot()[0]).toMatchObject({
            state: 'waiting',
            interactivePrompt: JSON.stringify({ questions: [QUESTION] })
          })
        },
        { timeout: 3_000, interval: 50 }
      )
      const waiting = published.at(-1)
      expect(waiting?.payload.state).toBe('waiting')
      expect(waiting?.hasExplicitPrompt).toBeUndefined()

      appendFileSync(
        logPath,
        sessionLogLine({ kind: 'user_input_prompt_settled', prompt_id: PROMPT_ID })
      )
      await vi.waitFor(
        () => {
          expect(server.getStatusSnapshot()[0]?.state).toBe('working')
        },
        { timeout: 3_000, interval: 50 }
      )
      expect(published.at(-1)?.hasExplicitPrompt).toBeUndefined()
      expect(server.getStatusSnapshot()[0]?.interactivePrompt).toBeUndefined()
    } finally {
      server.stop()
    }
  })
})

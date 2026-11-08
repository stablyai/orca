import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentHookServer, _internals } from './server'
import { buildBody } from './server.test-fixtures'

const { getCohortAtEmitMock, trackMock } = vi.hoisted(() => ({
  getCohortAtEmitMock: vi.fn(),
  trackMock: vi.fn()
}))

vi.mock('../telemetry/client', () => ({
  track: trackMock
}))

vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: getCohortAtEmitMock
}))

beforeEach(() => {
  _internals.resetCachesForTests()
  trackMock.mockReset()
  getCohortAtEmitMock.mockReset()
  getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Copilot hook normalization', () => {
  it('updates Copilot Stop with final transcript text after a non-blocking retry', async () => {
    const server = new AgentHookServer()
    const tmpDir = mkdtempSync(join(tmpdir(), 'orca-copilot-transcript-retry-'))
    const transcriptPath = join(tmpDir, 'events.jsonl')
    writeFileSync(transcriptPath, '')
    await server.start({ env: 'production' })
    try {
      const env = server.buildPtyEnv()
      const listener = vi.fn()
      server.setListener(listener)

      await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/copilot`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
        },
        body: JSON.stringify(
          buildBody({
            hook_event_name: 'PostToolUse',
            tool_result: { text_result_for_llm: 'stale tool output' }
          })
        )
      })
      const response = await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/copilot`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
        },
        body: JSON.stringify(
          buildBody({ hook_event_name: 'Stop', transcript_path: transcriptPath })
        )
      })

      expect(response.status).toBe(204)
      await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/copilot`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
        },
        body: JSON.stringify(buildBody({ hook_event_name: 'SessionEnd', reason: 'complete' }))
      })
      expect(listener).toHaveBeenLastCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            state: 'done',
            lastAssistantMessage: undefined
          })
        })
      )

      // Let the first 50ms retry miss so continuation across SessionEnd is proven.
      await new Promise((resolve) => setTimeout(resolve, 70))
      writeFileSync(
        transcriptPath,
        `${JSON.stringify({
          type: 'assistant.message',
          data: { content: 'Done after transcript flush.' }
        })}\n`
      )
      await new Promise((resolve) => setTimeout(resolve, 120))

      expect(listener).toHaveBeenLastCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            state: 'done',
            lastAssistantMessage: 'Done after transcript flush.'
          })
        })
      )
    } finally {
      server.stop()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('updates Grok Stop with final chat-history text after a non-blocking retry', async () => {
    const server = new AgentHookServer()
    const tmpDir = mkdtempSync(join(tmpdir(), 'orca-grok-chat-history-retry-'))
    const sessionId = '019e37f4-5135-7b63-a4ab-6d13aa6bf528'
    const cwd = join(tmpDir, 'workspace')
    const sessionDir = join(tmpDir, '.grok', 'sessions', encodeURIComponent(cwd), sessionId)
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(join(sessionDir, 'chat_history.jsonl'), '')
    vi.stubEnv('HOME', tmpDir)
    vi.stubEnv('USERPROFILE', tmpDir)
    await server.start({ env: 'production' })
    try {
      const env = server.buildPtyEnv()
      const listener = vi.fn()
      server.setListener(listener)

      await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/grok`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
        },
        body: JSON.stringify(buildBody({ hookEventName: 'user_prompt_submit', prompt: 'hihi' }))
      })
      const response = await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/grok`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
        },
        body: JSON.stringify(buildBody({ hookEventName: 'Stop', sessionId, cwd }))
      })

      expect(response.status).toBe(204)
      expect(listener).toHaveBeenLastCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            state: 'done',
            lastAssistantMessage: undefined
          })
        })
      )

      writeFileSync(
        join(sessionDir, 'chat_history.jsonl'),
        `${JSON.stringify({ type: 'assistant', content: 'Hi! How can I help you today?' })}\n`
      )
      await new Promise((resolve) => setTimeout(resolve, 120))

      expect(listener).toHaveBeenLastCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            state: 'done',
            lastAssistantMessage: 'Hi! How can I help you today?'
          })
        })
      )
    } finally {
      server.stop()
      vi.unstubAllEnvs()
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_STATUS_ASSISTANT_MESSAGE_MAX_LENGTH } from '../../shared/agent-status-types'
import {
  ASSISTANT_MESSAGE_RETRY_ATTEMPTS,
  ASSISTANT_MESSAGE_RETRY_MS
} from '../agent-hooks/server/server-constants'
import { createPane, observe } from './runtime-terminal-run-observer-test-pane'

const REPLY_RETRY_WINDOW_MS = ASSISTANT_MESSAGE_RETRY_ATTEMPTS * ASSISTANT_MESSAGE_RETRY_MS

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('completed terminal run output', () => {
  it("saves the agent's final reply, not the screen with its prompt and chrome", async () => {
    const pane = createPane({ idle: false, tail: ['=== TASK ===', 'Summarize', '❯', 'status bar'] })
    const run = observe(pane)
    await vi.advanceTimersByTimeAsync(1_000)
    pane.report({ lastAssistantMessage: 'Brief written; Linear was unavailable.' })
    pane.becomeIdle()
    await run.promise
    expect(run.settled).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'completed',
        outputSnapshot: expect.objectContaining({
          content: 'Brief written; Linear was unavailable.',
          truncated: false
        })
      })
    )
  })

  it('falls back to the screen when the reply is tool output', async () => {
    const pane = createPane({ idle: false, tail: ['agent screen'] })
    const run = observe(pane)
    await vi.advanceTimersByTimeAsync(1_000)
    pane.report({ lastAssistantMessage: 'npm test output', lastAssistantMessageIsToolOutput: true })
    pane.becomeIdle()
    await run.promise
    expect(run.settled).toHaveBeenCalledWith(
      expect.objectContaining({
        outputSnapshot: expect.objectContaining({ content: 'agent screen' })
      })
    )
  })

  it('waits for the hook service to enrich a fresh done with its final reply', async () => {
    const pane = createPane({ idle: false, tail: ['prompt', 'status bar'] })
    const run = observe(pane)
    const doneAt = Date.now()
    pane.report()
    pane.becomeIdle()
    await vi.advanceTimersByTimeAsync(REPLY_RETRY_WINDOW_MS - ASSISTANT_MESSAGE_RETRY_MS)
    expect(run.settled).not.toHaveBeenCalled()

    pane.report({ stateStartedAt: doneAt, lastAssistantMessage: 'Final reply after flush.' })
    await vi.advanceTimersByTimeAsync(ASSISTANT_MESSAGE_RETRY_MS)
    await run.promise
    expect(run.settled).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'completed',
        outputSnapshot: expect.objectContaining({ content: 'Final reply after flush.' })
      })
    )
  })

  it('falls back to the screen after the hook retry window without a reply', async () => {
    const pane = createPane({ idle: false, tail: ['screen fallback'] })
    const run = observe(pane)
    pane.report()
    pane.becomeIdle()
    await vi.advanceTimersByTimeAsync(REPLY_RETRY_WINDOW_MS - 1)
    expect(run.settled).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await run.promise
    expect(run.settled).toHaveBeenCalledWith(
      expect.objectContaining({
        outputSnapshot: expect.objectContaining({ content: 'screen fallback', truncated: false })
      })
    )
  })

  it('marks a cap-saturated reply as truncated before trimming the snapshot', async () => {
    const pane = createPane({ idle: false, tail: ['status bar'] })
    const run = observe(pane)
    const reply = `${'a'.repeat(AGENT_STATUS_ASSISTANT_MESSAGE_MAX_LENGTH - 1)}\n`
    pane.report({ lastAssistantMessage: reply })
    pane.becomeIdle()
    await run.promise
    expect(run.settled).toHaveBeenCalledWith(
      expect.objectContaining({
        outputSnapshot: expect.objectContaining({ content: reply.trim(), truncated: true })
      })
    )
  })

  it('cancels a pending reply re-read without recording a result', async () => {
    const pane = createPane({ idle: false, tail: ['status bar'] })
    const run = observe(pane)
    pane.report()
    pane.becomeIdle()
    await vi.advanceTimersByTimeAsync(ASSISTANT_MESSAGE_RETRY_MS)
    run.controller.abort()
    await run.promise
    expect(run.settled).not.toHaveBeenCalled()
    expect(run.failed).toHaveBeenCalledWith(expect.objectContaining({ message: 'request_aborted' }))
  })
})

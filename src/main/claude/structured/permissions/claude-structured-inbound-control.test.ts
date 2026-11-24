import { describe, expect, it } from 'vitest'
import type { ClaudeStructuredSessionEvent } from '../lifecycle/claude-structured-session-event'
import {
  createClaudeInitProof,
  type ClaudeInitObservation
} from '../startup/claude-structured-init-proof'
import { ClaudePromptRegistry } from './claude-prompt-registry'
import { buildClaudePermissionCallbacks } from './claude-structured-inbound-control'

// Runs what a pending request settles through, without a clock.
const settledTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

const sessionId = 'b6620d6f-5b1e-4a60-9c7f-1a3a4a5d9e01'
const init: ClaudeInitObservation = {
  providerSessionId: sessionId,
  uuid: 'init-1',
  model: 'claude-x',
  message: { type: 'system', subtype: 'init', session_id: sessionId }
}
const request = (signal = new AbortController().signal) => ({
  requestId: 'req-1',
  toolUseID: 'toolu_1',
  signal,
  suggestions: []
})

/** The permissions of a process that has not yet proved which session it runs. */
function unprovenPermissions(fullAccess: boolean) {
  const initProof = createClaudeInitProof()
  const events: ClaudeStructuredSessionEvent[] = []
  const { canUseTool } = buildClaudePermissionCallbacks({
    sessionId: 'chat-1',
    prompts: new ClaudePromptRegistry(),
    emit: (event) => events.push(event),
    fullAccessAt: () => fullAccess,
    initProof
  })
  return { initProof, events, canUseTool }
}

describe('buildClaudePermissionCallbacks', () => {
  it('never allows a Full access request that outran the proof of a session that is then refused', async () => {
    const { initProof, events, canUseTool } = unprovenPermissions(true)
    const pending = canUseTool('Bash', { command: 'echo hi' }, request())
    const cancelled = new AbortController()
    const withdrawn = canUseTool('Bash', { command: 'echo hi' }, request(cancelled.signal))
    cancelled.abort()
    await settledTurn()
    expect(events).toEqual([])
    initProof.refuse()

    // The SDK writes no response to a request its provider cancelled.
    await expect(withdrawn).resolves.toBeNull()
    await expect(pending).resolves.toMatchObject({ behavior: 'deny', toolUseID: 'toolu_1' })
    expect(events).toEqual([])
  })

  it('asks a request only once the session it belongs to is proven', async () => {
    const { initProof, events, canUseTool } = unprovenPermissions(false)
    const pending = canUseTool('Bash', { command: 'echo hi' }, request())
    await settledTurn()
    expect(events).toEqual([])

    initProof.resolve(init)
    await settledTurn()
    const [asked, ...rest] = events
    if (asked?.type !== 'prompt') {
      throw new Error(`expected a prompt, got ${JSON.stringify(asked)}`)
    }
    expect(rest).toEqual([])
    expect(asked.prompt).toMatchObject({
      requestId: 'req-1',
      toolUseId: 'toolu_1',
      toolName: 'Bash'
    })
    asked.prompt.settle({
      behavior: 'allow',
      updatedInput: asked.prompt.input,
      toolUseID: 'toolu_1'
    })

    await expect(pending).resolves.toMatchObject({ behavior: 'allow', toolUseID: 'toolu_1' })
  })
})

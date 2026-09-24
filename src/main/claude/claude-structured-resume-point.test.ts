import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeStructuredSessionEvent } from './claude-structured-session-adapter'
import {
  adapterFor,
  fakeClaude,
  identityFor,
  PROVIDER_SESSION_ID,
  recordingJournalSink,
  tick
} from './claude-structured-session-test-support'

/** A resumed owner that completed one turn (`a4`) and then saw the next turn's prompt. */
async function ownerMidSecondTurn(persisted: unknown[]) {
  const claude = fakeClaude()
  const adapter = adapterFor(
    claude,
    { resumed: true, resumeLeafUuid: 'a3', options: { resume: PROVIDER_SESSION_ID } },
    [],
    persisted
  )
  await adapter.acquire({
    identity: identityFor(),
    fence: 7,
    spawnToken: 'spawn-7',
    events: recordingJournalSink()
  })
  const frame = (message: Record<string, unknown>) =>
    claude.connections[0]!.handlers.onMessage?.({ session_id: PROVIDER_SESSION_ID, ...message })
  frame({ type: 'user', uuid: 'u4' })
  frame({ type: 'assistant', uuid: 'a4' })
  frame({ type: 'result', subtype: 'success', uuid: 'a4-result' })
  frame({ type: 'user', uuid: 'u5' })
  return { adapter, claude, frame }
}

const lastCompletedTurn = { providerSessionId: PROVIDER_SESSION_ID, leafUuid: 'a4', fence: 7 }

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Claude resume point is the last completed turn on every exit path', () => {
  it('on close', async () => {
    const persisted: unknown[] = []
    const { adapter } = await ownerMidSecondTurn(persisted)
    await expect(adapter.closeSession('session-1')).resolves.toBe(true)
    expect(persisted).toEqual([expect.objectContaining(lastCompletedTurn)])
  })

  it('on an unexpected exit', async () => {
    const persisted: unknown[] = []
    const { adapter, claude } = await ownerMidSecondTurn(persisted)
    claude.connections[0]!.handlers.onExit?.(new Error('claude crashed'))
    await adapter.drainObservedExits()
    await tick()
    expect(persisted).toEqual([expect.objectContaining(lastCompletedTurn)])
  })

  it('on an acquisition release', async () => {
    const persisted: unknown[] = []
    const { adapter } = await ownerMidSecondTurn(persisted)
    await expect(adapter.releaseAcquisition({ sessionId: 'session-1' })).resolves.toBe(true)
    expect(persisted).toEqual([expect.objectContaining(lastCompletedTurn)])
  })

  it('carries the launch leaf forward when no turn completed', async () => {
    const persisted: unknown[] = []
    const claude = fakeClaude()
    const adapter = adapterFor(
      claude,
      { resumed: true, resumeLeafUuid: 'a3', options: { resume: PROVIDER_SESSION_ID } },
      [],
      persisted
    )
    const acquisition = await adapter.acquire({
      identity: identityFor(),
      fence: 7,
      spawnToken: 'spawn-7',
      events: recordingJournalSink()
    })
    expect(acquisition.link.handle).toMatchObject({ leafUuid: 'a3' })
    await expect(adapter.closeSession('session-1')).resolves.toBe(true)
    expect(persisted).toEqual([expect.objectContaining({ leafUuid: 'a3' })])
  })

  it('saves only real messages: hook, attachment, and result frames never become the leaf', async () => {
    const persisted: unknown[] = []
    const { adapter, frame } = await ownerMidSecondTurn(persisted)
    frame({ type: 'assistant', uuid: 'a5' })
    // Claude's transcript chains these after a reply; the live stream never adopts them.
    frame({ type: 'system', subtype: 'stop_hook_summary', uuid: 'a5-hook-summary' })
    frame({ type: 'attachment', uuid: 'a5-attachment' })
    frame({ type: 'result', subtype: 'success', uuid: 'a5-result' })
    await expect(adapter.closeSession('session-1')).resolves.toBe(true)
    expect(persisted).toEqual([expect.objectContaining({ leafUuid: 'a5' })])
  })

  it('on an unexpected exit whose durable write fails, still ends the session and logs', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const events: ClaudeStructuredSessionEvent[] = []
    const claude = fakeClaude()
    const adapter = adapterFor(
      claude,
      { resumed: true, resumeLeafUuid: 'a3', options: { resume: PROVIDER_SESSION_ID } },
      events,
      [],
      undefined,
      async () => {
        throw new Error('record write failed')
      }
    )
    await adapter.acquire({
      identity: identityFor(),
      fence: 7,
      spawnToken: 'spawn-7',
      events: recordingJournalSink()
    })
    claude.connections[0]!.handlers.onExit?.(new Error('claude crashed'))
    await adapter.drainObservedExits()
    await tick()
    expect(events.at(-1)).toMatchObject({ type: 'ended', cause: 'unexpected-exit' })
    expect(warn).toHaveBeenCalledWith(
      '[claude-resume-point] exit cursor was not persisted:',
      expect.objectContaining({ sessionId: 'session-1', error: expect.any(Error) })
    )
  })
})

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { dispatchClaudeTurn, resolveClaudeReplayWaiter } from './claude-structured-dispatch'
import { readClaudeImage } from './claude-structured-dispatch-content'
import { claudeUnwrittenUserMessageError } from './claude-agent-sdk-user-message-queue'
import type { ClaudeSession } from './claude-structured-session-state'
import {
  childExited,
  sessionFor,
  userMessage,
  userReplayFrame
} from './claude-structured-dispatch-test-support'

describe('Claude structured dispatch image limits', () => {
  it.each(['isMeta', 'isSynthetic', 'isCompactSummary'])(
    'does not acknowledge a dispatch with %s context even when the client uuid matches',
    async (flag) => {
      const session = sessionFor()
      const settled = vi.fn()
      const dispatched = dispatchClaudeTurn(session, {
        clientMessageId: 'client-1',
        body: userMessage([{ type: 'text', text: '/example' }])
      })
      await vi.waitFor(() => expect(session.dispatchWaiters).toHaveLength(1))
      const sentUuid = session.dispatchWaiters[0]!.sentUuid
      const replay = userReplayFrame(sentUuid, '/example')
      expect(resolveClaudeReplayWaiter(session, { ...replay, [flag]: true }, settled)).toBe(false)
      expect(session.dispatchWaiters).toHaveLength(1)
      expect(settled).not.toHaveBeenCalled()
      expect(resolveClaudeReplayWaiter(session, replay, settled)).toBe(true)
      await expect(dispatched).resolves.toEqual({ state: 'admitted' })
      expect(settled).toHaveBeenCalledWith({
        clientMessageId: 'client-1',
        providerIdentity: { provider: 'claude', sessionId: 'provider-session', uuid: sentUuid }
      })
    }
  )

  it('takes the active turn identity from a replay that lands after dispatch returned', async () => {
    const session = sessionFor()
    const dispatched = dispatchClaudeTurn(session, {
      clientMessageId: 'client-1',
      body: userMessage([{ type: 'text', text: 'one' }])
    })
    await vi.waitFor(() => expect(session.dispatchWaiters).toHaveLength(1))
    const sentUuid = (session.dispatchWaiters[0] as { sentUuid?: string }).sentUuid
    await expect(dispatched).resolves.toEqual({ state: 'admitted' })
    expect(session.activeTurnId).toBeUndefined()

    expect(resolveClaudeReplayWaiter(session, userReplayFrame(sentUuid!, 'one'))).toBe(true)
    expect(session.activeTurnId).toBe(sentUuid)
    expect(session.activeTurnSequence).toBe(session.dispatchSequence)
  })

  it('recovers the active identity when a replay lands after the child died', async () => {
    const session = sessionFor()
    const dispatched = dispatchClaudeTurn(session, {
      clientMessageId: 'client-1',
      body: userMessage([{ type: 'text', text: 'one' }])
    })
    await vi.waitFor(() => expect(session.dispatchWaiters).toHaveLength(1))
    const sentUuid = (session.dispatchWaiters[0] as { sentUuid?: string }).sentUuid
    await expect(dispatched).resolves.toEqual({ state: 'admitted' })
    childExited(session)
    expect(session.dispatchWaiters).toHaveLength(0)
    expect(session.retiredDispatchWaiters).toHaveLength(1)

    expect(resolveClaudeReplayWaiter(session, userReplayFrame(sentUuid!, 'one'))).toBe(true)
    expect(session.activeTurnId).toBe(sentUuid)
    expect(session.activeTurnSequence).toBe(session.dispatchSequence)
  })

  it('settles the send the replay proves was delivered, whenever it arrives', async () => {
    const session = sessionFor()
    const settled = vi.fn()
    const dispatched = dispatchClaudeTurn(session, {
      clientMessageId: 'client-1',
      body: userMessage([{ type: 'text', text: 'one' }])
    })
    await vi.waitFor(() => expect(session.dispatchWaiters).toHaveLength(1))
    const sentUuid = (session.dispatchWaiters[0] as { sentUuid?: string }).sentUuid
    await expect(dispatched).resolves.toEqual({ state: 'admitted' })

    resolveClaudeReplayWaiter(session, userReplayFrame(sentUuid!, 'one'), settled)
    expect(settled).toHaveBeenCalledWith({
      clientMessageId: 'client-1',
      providerIdentity: { provider: 'claude', sessionId: 'provider-session', uuid: sentUuid }
    })
  })

  it('settles a superseded dispatch even though it no longer owns the turn identity', async () => {
    const session = sessionFor()
    const settled = vi.fn()
    const first = dispatchClaudeTurn(session, {
      clientMessageId: 'client-1',
      body: userMessage([{ type: 'text', text: 'one' }])
    })
    await vi.waitFor(() => expect(session.dispatchWaiters).toHaveLength(1))
    const firstUuid = (session.dispatchWaiters[0] as { sentUuid?: string }).sentUuid
    await expect(first).resolves.toEqual({ state: 'admitted' })
    childExited(session)

    const second = dispatchClaudeTurn(session, {
      clientMessageId: 'client-2',
      body: userMessage([{ type: 'text', text: 'two' }])
    })
    await vi.waitFor(() => expect(session.dispatchWaiters).toHaveLength(1))
    const secondUuid = (session.dispatchWaiters[0] as { sentUuid?: string }).sentUuid

    // The stale replay must not claim the active turn, but the message it names
    // did land, so the send it came from is delivered and must stop reading as
    // unconfirmed — that banner is what makes a user resend a duplicate.
    expect(resolveClaudeReplayWaiter(session, userReplayFrame(firstUuid!, 'one'), settled)).toBe(
      false
    )
    expect(settled).toHaveBeenCalledWith({
      clientMessageId: 'client-1',
      providerIdentity: { provider: 'claude', sessionId: 'provider-session', uuid: firstUuid }
    })
    expect(resolveClaudeReplayWaiter(session, userReplayFrame(secondUuid!, 'two'), settled)).toBe(
      true
    )
    await expect(second).resolves.toEqual({ state: 'admitted' })
    expect(settled).toHaveBeenLastCalledWith({
      clientMessageId: 'client-2',
      providerIdentity: { provider: 'claude', sessionId: 'provider-session', uuid: secondUuid }
    })
  })

  it('never lets a late replay for dispatch A resolve dispatch B', async () => {
    const session = sessionFor()
    const settled = vi.fn()
    const first = dispatchClaudeTurn(session, {
      clientMessageId: 'client-1',
      body: userMessage([{ type: 'text', text: 'one' }])
    })
    await vi.waitFor(() => expect(session.dispatchWaiters).toHaveLength(1))
    const firstUuid = (session.dispatchWaiters[0] as { sentUuid?: string }).sentUuid
    await expect(first).resolves.toEqual({ state: 'admitted' })
    childExited(session)

    await expect(
      dispatchClaudeTurn(session, {
        clientMessageId: 'client-2',
        body: userMessage([{ type: 'text', text: 'two' }])
      })
    ).resolves.toEqual({ state: 'admitted' })
    const secondUuid = (session.dispatchWaiters[0] as { sentUuid?: string }).sentUuid

    expect(resolveClaudeReplayWaiter(session, userReplayFrame(firstUuid!, 'one'))).toBe(false)
    expect(session.dispatchWaiters[0]).toMatchObject({ sentUuid: secondUuid })
    expect(resolveClaudeReplayWaiter(session, userReplayFrame(secondUuid!, 'two'), settled)).toBe(
      true
    )
    expect(settled).toHaveBeenCalledWith({
      clientMessageId: 'client-2',
      providerIdentity: { provider: 'claude', sessionId: 'provider-session', uuid: secondUuid }
    })
  })

  it('does not let an identical late replay for dispatch A resolve active dispatch B', async () => {
    const session = sessionFor()
    const settled = vi.fn()
    const first = dispatchClaudeTurn(session, {
      clientMessageId: 'client-1',
      body: userMessage([{ type: 'text', text: 'same prompt' }])
    })
    await vi.waitFor(() => expect(session.dispatchWaiters).toHaveLength(1))
    await expect(first).resolves.toEqual({ state: 'admitted' })
    childExited(session)

    const second = dispatchClaudeTurn(session, {
      clientMessageId: 'client-2',
      body: userMessage([{ type: 'text', text: 'same prompt' }])
    })
    await vi.waitFor(() => expect(session.dispatchWaiters).toHaveLength(1))
    const secondUuid = session.dispatchWaiters[0]!.sentUuid

    expect(resolveClaudeReplayWaiter(session, userReplayFrame('provider-a', 'same prompt'))).toBe(
      false
    )
    expect(session.dispatchWaiters[0]).toMatchObject({ sentUuid: secondUuid })

    resolveClaudeReplayWaiter(session, userReplayFrame(secondUuid, 'same prompt'), settled)
    await expect(second).resolves.toEqual({ state: 'admitted' })
    expect(settled).toHaveBeenCalledWith({
      clientMessageId: 'client-2',
      providerIdentity: { provider: 'claude', sessionId: 'provider-session', uuid: secondUuid }
    })
  })

  it('does not let a fresh-UUID replay for an evicted dispatch resolve active dispatch B', async () => {
    const session = sessionFor()
    const first = dispatchClaudeTurn(session, {
      clientMessageId: 'client-1',
      body: userMessage([{ type: 'text', text: 'same prompt' }])
    })
    await vi.waitFor(() => expect(session.dispatchWaiters).toHaveLength(1))
    await expect(first).resolves.toEqual({ state: 'admitted' })
    childExited(session)
    const firstUuid = session.retiredDispatchWaiters[0]!.sentUuid

    const fillerDispatches = await Promise.all(
      Array.from({ length: 64 }, (_, index) =>
        dispatchClaudeTurn(session, {
          clientMessageId: `filler-${index}`,
          body: userMessage([{ type: 'text', text: 'same prompt' }])
        })
      )
    )
    expect(fillerDispatches.every((outcome) => outcome.state === 'admitted')).toBe(true)
    childExited(session)
    expect(session.retiredDispatchWaiters).toHaveLength(64)
    expect(session.replayContentFallbackBlocked).toBe(true)
    expect(session.retiredDispatchWaiters.some((waiter) => waiter.sentUuid === firstUuid)).toBe(
      false
    )

    while (session.retiredDispatchWaiters.length > 0) {
      const sentUuid = session.retiredDispatchWaiters[0]!.sentUuid
      resolveClaudeReplayWaiter(session, userReplayFrame(sentUuid, 'same prompt'))
    }
    expect(session.retiredDispatchWaiters).toHaveLength(0)

    const second = dispatchClaudeTurn(session, {
      clientMessageId: 'client-2',
      body: userMessage([{ type: 'text', text: 'same prompt' }])
    })
    await vi.waitFor(() => expect(session.dispatchWaiters).toHaveLength(1))
    const secondUuid = session.dispatchWaiters[0]!.sentUuid
    const settled = vi.fn()

    expect(
      resolveClaudeReplayWaiter(session, userReplayFrame('provider-a-late', 'same prompt'))
    ).toBe(false)
    expect(session.dispatchWaiters[0]).toMatchObject({ sentUuid: secondUuid })

    resolveClaudeReplayWaiter(session, userReplayFrame(secondUuid, 'same prompt'), settled)
    await expect(second).resolves.toEqual({ state: 'admitted' })
    expect(settled).toHaveBeenCalledWith({
      clientMessageId: 'client-2',
      providerIdentity: { provider: 'claude', sessionId: 'provider-session', uuid: secondUuid }
    })
  })

  it('does not let a fresh-UUID result for an evicted slash dispatch resolve active dispatch B', async () => {
    const session = sessionFor()
    const first = dispatchClaudeTurn(session, {
      clientMessageId: 'client-1',
      body: userMessage([{ type: 'text', text: '/permissions' }])
    })
    await vi.waitFor(() => expect(session.dispatchWaiters).toHaveLength(1))
    await expect(first).resolves.toEqual({ state: 'admitted' })
    childExited(session)
    const firstUuid = session.retiredDispatchWaiters[0]!.sentUuid

    const fillerDispatches = await Promise.all(
      Array.from({ length: 64 }, (_, index) =>
        dispatchClaudeTurn(session, {
          clientMessageId: `filler-${index}`,
          body: userMessage([{ type: 'text', text: '/permissions' }])
        })
      )
    )
    expect(fillerDispatches.every((outcome) => outcome.state === 'admitted')).toBe(true)
    childExited(session)
    expect(session.retiredDispatchWaiters).toHaveLength(64)
    expect(session.replayContentFallbackBlocked).toBe(true)
    expect(session.retiredDispatchWaiters.some((waiter) => waiter.sentUuid === firstUuid)).toBe(
      false
    )

    while (session.retiredDispatchWaiters.length > 0) {
      const sentUuid = session.retiredDispatchWaiters[0]!.sentUuid
      expect(
        resolveClaudeReplayWaiter(session, {
          type: 'result',
          subtype: 'success',
          session_id: 'provider-session',
          uuid: `result-${sentUuid}`,
          user_message_uuid: sentUuid
        })
      ).toBe(false)
    }
    expect(session.retiredDispatchWaiters).toHaveLength(0)

    const second = dispatchClaudeTurn(session, {
      clientMessageId: 'client-2',
      body: userMessage([{ type: 'text', text: '/permissions' }])
    })
    await vi.waitFor(() => expect(session.dispatchWaiters).toHaveLength(1))
    const secondUuid = session.dispatchWaiters[0]!.sentUuid
    const settled = vi.fn()

    expect(
      resolveClaudeReplayWaiter(session, {
        type: 'result',
        subtype: 'success',
        session_id: 'provider-session',
        uuid: 'result-a-late'
      })
    ).toBe(false)
    expect(session.dispatchWaiters[0]).toMatchObject({ sentUuid: secondUuid })

    expect(
      resolveClaudeReplayWaiter(
        session,
        {
          type: 'result',
          subtype: 'success',
          session_id: 'provider-session',
          uuid: 'result-b',
          user_message_uuid: secondUuid
        },
        settled
      )
    ).toBe(false)
    await expect(second).resolves.toEqual({ state: 'admitted' })
    expect(settled).toHaveBeenCalledWith({
      clientMessageId: 'client-2',
      providerIdentity: { provider: 'claude', sessionId: 'provider-session', uuid: 'result-b' }
    })
  })

  it('does not let a legacy result for timed-out ordinary dispatch A resolve slash dispatch B', async () => {
    const session = sessionFor()
    const settled = vi.fn()
    const first = dispatchClaudeTurn(session, {
      clientMessageId: 'client-1',
      body: userMessage([{ type: 'text', text: 'ordinary' }])
    })
    await vi.waitFor(() => expect(session.dispatchWaiters).toHaveLength(1))
    await expect(first).resolves.toEqual({ state: 'admitted' })
    childExited(session)

    const second = dispatchClaudeTurn(session, {
      clientMessageId: 'client-2',
      body: userMessage([{ type: 'text', text: '/permissions' }])
    })
    await vi.waitFor(() => expect(session.dispatchWaiters).toHaveLength(1))

    expect(
      resolveClaudeReplayWaiter(
        session,
        {
          type: 'result',
          subtype: 'success',
          session_id: 'provider-session',
          uuid: 'legacy-result-a'
        },
        settled
      )
    ).toBe(false)
    await expect(second).resolves.toEqual({ state: 'admitted' })
    // Ambiguous, so it settles nothing: the slash waiter is still waiting.
    expect(session.dispatchWaiters).toHaveLength(1)
    expect(settled).not.toHaveBeenCalled()
  })

  it('removes only its own waiter when a later send fails', async () => {
    const session = sessionFor()
    const settled = vi.fn()
    const first = dispatchClaudeTurn(session, {
      clientMessageId: 'client-1',
      body: userMessage([{ type: 'text', text: 'one' }])
    })
    await vi.waitFor(() => expect(session.dispatchWaiters).toHaveLength(1))
    const firstWaiter = session.dispatchWaiters[0]
    session.connection.send = vi
      .fn()
      .mockRejectedValue(claudeUnwrittenUserMessageError(new Error('broken pipe')))

    // A refused write is a transport fact, and the only thing besides child exit
    // that puts one message's delivery in doubt.
    await expect(
      dispatchClaudeTurn(session, {
        clientMessageId: 'client-2',
        body: userMessage([{ type: 'text', text: 'two' }])
      })
    ).resolves.toEqual({ state: 'unknown', reason: 'provider_write_failed: broken pipe' })
    expect(session.dispatchWaiters).toEqual([firstWaiter])

    const firstUuid = (firstWaiter as { sentUuid?: string }).sentUuid
    resolveClaudeReplayWaiter(session, userReplayFrame(firstUuid!, 'one'), settled)
    await expect(first).resolves.toEqual({ state: 'admitted' })
    expect(settled).toHaveBeenCalledWith({
      clientMessageId: 'client-1',
      providerIdentity: { provider: 'claude', sessionId: 'provider-session', uuid: firstUuid }
    })
  })

  it('does not let a provably unwritten attempt block retry correlation', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(claudeUnwrittenUserMessageError(new Error('broken pipe')))
      .mockResolvedValue(undefined)
    const session = sessionFor(send)
    const body = userMessage([{ type: 'text', text: 'retry me' }])

    await expect(
      dispatchClaudeTurn(session, { clientMessageId: 'client-1', body })
    ).resolves.toEqual({ state: 'unknown', reason: 'provider_write_failed: broken pipe' })
    expect(session.dispatchWaiters).toHaveLength(0)
    expect(session.retiredDispatchWaiters).toHaveLength(0)

    await expect(
      dispatchClaudeTurn(session, { clientMessageId: 'client-1', body })
    ).resolves.toEqual({ state: 'admitted' })
    expect(resolveClaudeReplayWaiter(session, userReplayFrame('fresh-replay', 'retry me'))).toBe(
      true
    )
    expect(session.activeTurnId).toBe('fresh-replay')
  })

  it('does not claim an SDK-pulled frame was unwritten when its write outcome is ambiguous', async () => {
    const session = sessionFor(vi.fn().mockRejectedValue(new Error('input pump stopped')))

    await expect(
      dispatchClaudeTurn(session, {
        clientMessageId: 'client-1',
        body: userMessage([{ type: 'text', text: 'one' }])
      })
    ).resolves.toEqual({
      state: 'unknown',
      reason: 'provider_write_outcome_unknown: input pump stopped'
    })
  })

  it('keeps a replay accepted before its send reports failure', async () => {
    let session!: ClaudeSession
    const send = vi.fn(async (message: Record<string, unknown>) => {
      resolveClaudeReplayWaiter(session, { ...message, uuid: 'turn-race' })
      throw new Error('write raced provider acknowledgement')
    })
    session = sessionFor(send)

    await expect(
      dispatchClaudeTurn(session, {
        clientMessageId: 'client-1',
        body: userMessage([{ type: 'text', text: 'one' }])
      })
    ).resolves.toMatchObject({ state: 'accepted', providerIdentity: { uuid: 'turn-race' } })
    expect(session.dispatchWaiters).toHaveLength(0)
  })

  it('accepts a slash command from its result receipt when Claude omits the user replay', async () => {
    const session = sessionFor()
    const settled = vi.fn()
    const dispatched = dispatchClaudeTurn(session, {
      clientMessageId: 'client-1',
      body: userMessage([{ type: 'text', text: '/permissions' }])
    })
    await vi.waitFor(() => expect(session.dispatchWaiters).toHaveLength(1))

    expect(
      resolveClaudeReplayWaiter(
        session,
        {
          type: 'result',
          subtype: 'success',
          session_id: 'provider-session',
          uuid: 'command-result-uuid'
        },
        settled
      )
    ).toBe(false)

    await expect(dispatched).resolves.toEqual({ state: 'admitted' })
    expect(settled).toHaveBeenCalledWith({
      clientMessageId: 'client-1',
      providerIdentity: {
        provider: 'claude',
        sessionId: 'provider-session',
        uuid: 'command-result-uuid'
      }
    })
  })

  it('accepts a slash command sent with an attachment from its result receipt', async () => {
    const session = sessionFor()
    const settled = vi.fn()
    const dispatched = dispatchClaudeTurn(session, {
      clientMessageId: 'client-1',
      body: userMessage([
        { type: 'text', text: '/permissions' },
        { type: 'image-ref', url: 'https://example.test/a.png' }
      ])
    })
    await vi.waitFor(() => expect(session.dispatchWaiters).toHaveLength(1))
    // The mapper moves the image ahead of the prompt, so Claude runs the command and replies
    // with a result receipt instead of a user replay.
    expect(
      resolveClaudeReplayWaiter(
        session,
        {
          type: 'result',
          subtype: 'success',
          session_id: 'provider-session',
          uuid: 'command-result-uuid'
        },
        settled
      )
    ).toBe(false)

    await expect(dispatched).resolves.toEqual({ state: 'admitted' })
    expect(settled).toHaveBeenCalledWith({
      clientMessageId: 'client-1',
      providerIdentity: {
        provider: 'claude',
        sessionId: 'provider-session',
        uuid: 'command-result-uuid'
      }
    })
    // The sent order is the fix: the waiter's verdict alone was already what it is today.
    expect(session.connection.send).toHaveBeenCalledWith(
      expect.objectContaining({
        message: {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'url', url: 'https://example.test/a.png' } },
            { type: 'text', text: '/permissions' }
          ]
        }
      })
    )
  })

  it('does not take a result receipt for leading whitespace Claude never reads as a command', async () => {
    const session = sessionFor()
    const settled = vi.fn()
    const dispatched = dispatchClaudeTurn(session, {
      clientMessageId: 'client-1',
      body: userMessage([{ type: 'text', text: '  /permissions' }])
    })
    await vi.waitFor(() => expect(session.dispatchWaiters).toHaveLength(1))

    expect(
      resolveClaudeReplayWaiter(
        session,
        {
          type: 'result',
          subtype: 'success',
          session_id: 'provider-session',
          uuid: 'unrelated-result-uuid'
        },
        settled
      )
    ).toBe(false)

    await expect(dispatched).resolves.toEqual({ state: 'admitted' })
    expect(session.dispatchWaiters).toHaveLength(1)
    expect(settled).not.toHaveBeenCalled()
  })

  it('correlates a later slash-command result by user_message_uuid despite a retired slash waiter', async () => {
    const session = sessionFor()
    const settled = vi.fn()
    const first = dispatchClaudeTurn(session, {
      clientMessageId: 'client-1',
      body: userMessage([{ type: 'text', text: '/permissions' }])
    })
    await vi.waitFor(() => expect(session.dispatchWaiters).toHaveLength(1))
    await expect(first).resolves.toEqual({ state: 'admitted' })
    childExited(session)

    const second = dispatchClaudeTurn(session, {
      clientMessageId: 'client-2',
      body: userMessage([{ type: 'text', text: '/permissions' }])
    })
    await vi.waitFor(() => expect(session.dispatchWaiters).toHaveLength(1))
    const secondUuid = session.dispatchWaiters[0]!.sentUuid

    expect(
      resolveClaudeReplayWaiter(
        session,
        {
          type: 'result',
          subtype: 'success',
          session_id: 'provider-session',
          uuid: 'result-b',
          user_message_uuid: secondUuid
        },
        settled
      )
    ).toBe(false)
    await expect(second).resolves.toEqual({ state: 'admitted' })
    expect(settled).toHaveBeenCalledWith({
      clientMessageId: 'client-2',
      providerIdentity: { provider: 'claude', sessionId: 'provider-session', uuid: 'result-b' }
    })
  })

  it('does not mistake a normal turn result for its missing user replay', async () => {
    const session = sessionFor()
    const settled = vi.fn()
    const dispatched = dispatchClaudeTurn(session, {
      clientMessageId: 'client-1',
      body: userMessage([{ type: 'text', text: 'hello' }])
    })
    await vi.waitFor(() => expect(session.dispatchWaiters).toHaveLength(1))

    expect(
      resolveClaudeReplayWaiter(session, {
        type: 'result',
        session_id: 'provider-session',
        uuid: 'unrelated-result-uuid'
      })
    ).toBe(false)
    expect(session.dispatchWaiters).toHaveLength(1)
    expect(
      resolveClaudeReplayWaiter(
        session,
        {
          type: 'user',
          parent_tool_use_id: null,
          session_id: 'provider-session',
          uuid: 'user-replay-uuid',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'hello' }]
          }
        },
        settled
      )
    ).toBe(true)

    await expect(dispatched).resolves.toEqual({ state: 'admitted' })
    expect(settled).toHaveBeenCalledWith({
      clientMessageId: 'client-1',
      providerIdentity: {
        provider: 'claude',
        sessionId: 'provider-session',
        uuid: 'user-replay-uuid'
      }
    })
  })

  it('ignores a top-level tool-result user frame while waiting for a slash command replay', async () => {
    const session = sessionFor()
    const settled = vi.fn()
    const dispatched = dispatchClaudeTurn(session, {
      clientMessageId: 'client-1',
      body: userMessage([{ type: 'text', text: '/permissions' }])
    })
    await vi.waitFor(() => expect(session.dispatchWaiters).toHaveLength(1))

    resolveClaudeReplayWaiter(session, {
      type: 'user',
      parent_tool_use_id: null,
      session_id: 'provider-session',
      uuid: 'tool-result-uuid',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'done' }]
      }
    })
    expect(session.dispatchWaiters).toHaveLength(1)

    resolveClaudeReplayWaiter(
      session,
      {
        type: 'user',
        parent_tool_use_id: null,
        session_id: 'provider-session',
        uuid: 'user-replay-uuid',
        message: {
          role: 'user',
          content: [{ type: 'text', text: '/permissions' }]
        }
      },
      settled
    )

    await expect(dispatched).resolves.toEqual({ state: 'admitted' })
    expect(settled).toHaveBeenCalledWith({
      clientMessageId: 'client-1',
      providerIdentity: {
        provider: 'claude',
        sessionId: 'provider-session',
        uuid: 'user-replay-uuid'
      }
    })
  })

  it('rejects more than twenty URL images before sending', async () => {
    const session = sessionFor()
    const body = userMessage(
      Array.from({ length: 21 }, (_, index) => ({
        type: 'image-ref' as const,
        url: `https://example.test/${index}.png`
      }))
    )

    await expect(
      dispatchClaudeTurn(session, { clientMessageId: 'client-1', body })
    ).resolves.toEqual({ state: 'rejected', reason: 'Claude messages support at most 20 images' })
    expect(session.connection.send).not.toHaveBeenCalled()
  })

  it('rejects local images whose aggregate size exceeds twenty MiB', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-claude-images-'))
    try {
      const paths = await Promise.all(
        Array.from({ length: 5 }, async (_, index) => {
          const path = join(directory, `${index}.png`)
          await writeFile(path, Buffer.alloc(5 * 1024 * 1024))
          return path
        })
      )
      const session = sessionFor()
      const body = userMessage(paths.map((path) => ({ type: 'image-ref' as const, path })))

      await expect(
        dispatchClaudeTurn(session, { clientMessageId: 'client-1', body })
      ).resolves.toEqual({
        state: 'rejected',
        reason: `Claude images must total no more than ${20 * 1024 * 1024} bytes`
      })
      expect(session.connection.send).not.toHaveBeenCalled()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects a local image by actual bytes read beyond the per-image cap', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-claude-image-'))
    try {
      const path = join(directory, 'oversized.png')
      await writeFile(path, Buffer.alloc(5 * 1024 * 1024 + 1))
      const session = sessionFor()
      const body = userMessage([{ type: 'image-ref', path }])

      await expect(
        dispatchClaudeTurn(session, { clientMessageId: 'client-1', body })
      ).resolves.toEqual({
        state: 'rejected',
        reason: `Claude image must be a non-empty file no larger than ${5 * 1024 * 1024} bytes`
      })
      expect(session.connection.send).not.toHaveBeenCalled()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('allocates local image reads from the file size, not the maximum cap', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-claude-image-'))
    const allocUnsafe = vi.spyOn(Buffer, 'allocUnsafe')
    try {
      const path = join(directory, 'small.png')
      await writeFile(path, Buffer.alloc(64))
      const session = sessionFor()
      const dispatched = dispatchClaudeTurn(session, {
        clientMessageId: 'client-1',
        body: userMessage([{ type: 'image-ref', path }])
      })
      await vi.waitFor(() => expect(session.dispatchWaiters).toHaveLength(1))
      const sentUuid = (session.dispatchWaiters[0] as { sentUuid?: string }).sentUuid
      resolveClaudeReplayWaiter(session, {
        ...userReplayFrame(sentUuid!, ''),
        message: {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' } }
          ]
        }
      })
      await expect(dispatched).resolves.toEqual({ state: 'admitted' })
      expect(allocUnsafe).toHaveBeenCalled()
      expect(allocUnsafe.mock.calls.some(([size]) => size === 64 + 1)).toBe(true)
      expect(allocUnsafe.mock.calls.some(([size]) => size >= 5 * 1024 * 1024)).toBe(false)
    } finally {
      allocUnsafe.mockRestore()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('bounds retained waiter identity bytes when image dispatches are retired', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-claude-image-'))
    try {
      const path = join(directory, 'large.png')
      await writeFile(path, Buffer.alloc(64 * 1024))
      const session = sessionFor()
      const body = userMessage([{ type: 'image-ref', path }])
      await Promise.all(
        Array.from({ length: 64 }, (_, index) =>
          dispatchClaudeTurn(session, { clientMessageId: `client-${index}`, body })
        )
      )
      childExited(session)

      expect(session.retiredDispatchWaiters).toHaveLength(64)
      const retainedKeyBytes = session.retiredDispatchWaiters.reduce(
        (total, waiter) => total + waiter.replayContentKey.length,
        0
      )
      expect(retainedKeyBytes).toBeLessThan(64 * 512)
      expect(
        session.retiredDispatchWaiters.every((waiter) => waiter.replayContentKey.length < 512)
      ).toBe(true)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects a local image when it grows after the initial stat', async () => {
    const stat = vi
      .fn()
      .mockResolvedValueOnce({ isFile: () => true, size: 64 })
      .mockResolvedValueOnce({ isFile: () => true, size: 128 })
    const read = vi.fn(async (buffer: Buffer, offset: number) => {
      if (read.mock.calls.length === 1) {
        buffer.fill(1, offset, offset + 64)
        return { bytesRead: 64, buffer }
      }
      return { bytesRead: 0, buffer }
    })
    const open = vi.fn().mockResolvedValue({
      stat,
      read,
      close: vi.fn().mockResolvedValue(undefined)
    } as never)
    await expect(readClaudeImage('/controlled/growing.png', open)).rejects.toThrow(
      `Claude image must be a non-empty file no larger than ${5 * 1024 * 1024} bytes`
    )
  })
})

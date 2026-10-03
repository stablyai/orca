import { describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { openCursorAcpConnection, CursorAcpRequestError } from './cursor-acp-connection'
import { createCursorAcpSession, type CursorAcpSessionEvents } from './cursor-acp-session'

import { cursorAcpFixtureLaunch as launch } from './cursor-acp-protocol-fixture'

function events(): CursorAcpSessionEvents {
  return { update: vi.fn(), request: vi.fn(), exit: vi.fn() }
}

describe('Cursor ACP protocol fixture', () => {
  it('creates one provider session, streams updates and ends from the prompt response', async () => {
    const observed = events()
    const session = await createCursorAcpSession({
      launch: launch(),
      cwd: tmpdir(),
      events: observed
    })
    try {
      expect(session.sessionId).toBe('fixture-conversation-1')
      expect(await session.prompt([{ type: 'text', text: 'fixture response' }])).toBe('end_turn')
      expect(observed.update).toHaveBeenCalledWith(
        {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'fixture response' }
        },
        false
      )
      expect(session.phase).toBe('ready')
    } finally {
      expect(await session.close()).toBe(true)
    }
  })

  it('loads the exact provider ID and delivers replay before it can prompt again', async () => {
    const observed = events()
    const session = await createCursorAcpSession({
      launch: launch(),
      cwd: tmpdir(),
      sessionId: 'saved-exact-id',
      events: observed
    })
    try {
      expect(session.sessionId).toBe('saved-exact-id')
      expect(observed.update).toHaveBeenCalledWith(
        expect.objectContaining({
          content: { type: 'text', text: 'fixture replay' }
        }),
        true
      )
      expect(await session.prompt([{ type: 'text', text: 'continued fixture' }])).toBe('end_turn')
    } finally {
      expect(await session.close()).toBe(true)
    }
  })

  it('rejects unsupported loading and authentication errors without making a replacement session', async () => {
    await expect(
      createCursorAcpSession({
        launch: launch({ FIXTURE_NO_LOAD: '1' }),
        cwd: tmpdir(),
        sessionId: 'saved-exact-id',
        events: events()
      })
    ).rejects.toThrow('does not support loading')
    const rejected = createCursorAcpSession({
      launch: launch({ FIXTURE_AUTH: '1' }),
      cwd: tmpdir(),
      events: events()
    })
    await expect(rejected).rejects.toBeInstanceOf(CursorAcpRequestError)
    await expect(rejected).rejects.toMatchObject({ method: 'session/new', code: -32000 })
  })

  it('answers bidirectional permission requests with string IDs and continues tool updates', async () => {
    const observed = events()
    const session = await createCursorAcpSession({
      launch: launch(),
      cwd: tmpdir(),
      events: observed
    })
    try {
      const prompt = session.prompt([{ type: 'text', text: 'approval' }])
      await vi.waitFor(() => expect(observed.request).toHaveBeenCalled())
      session.connection.respond('permission-1', {
        outcome: { outcome: 'selected', optionId: 'allow' }
      })
      expect(await prompt).toBe('end_turn')
      expect(observed.update).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tool-1',
          status: 'completed'
        }),
        false
      )
    } finally {
      expect(await session.close()).toBe(true)
    }
  })

  it('requires a cancelled prompt response before confirming cancellation', async () => {
    const observed = events()
    const session = await createCursorAcpSession({
      launch: launch(),
      cwd: tmpdir(),
      events: observed
    })
    try {
      expect(await session.cancel()).toBe(false)
      const prompt = session.prompt([{ type: 'text', text: 'cancel' }])
      await vi.waitFor(() => expect(observed.update).toHaveBeenCalled())
      expect(() => session.prompt([{ type: 'text', text: 'overlap' }])).toThrow('another prompt')
      expect(await session.cancel()).toBe(true)
      expect(await prompt).toBe('cancelled')
    } finally {
      expect(await session.close()).toBe(true)
    }
  })

  it('never calls an unconfirmed cancel complete and keeps the turn occupied', async () => {
    const observed = events()
    const session = await createCursorAcpSession({
      launch: launch({ FIXTURE_IGNORE_CANCEL: '1' }),
      cwd: tmpdir(),
      events: observed
    })
    const prompt = session.prompt([{ type: 'text', text: 'cancel' }])
    void prompt.catch(() => {})
    try {
      await vi.waitFor(() => expect(observed.update).toHaveBeenCalled())
      await expect(session.cancel(50)).rejects.toThrow('did not confirm cancellation')
      expect(session.phase).toBe('cancelling')
      expect(() => session.prompt([{ type: 'text', text: 'must not overlap' }])).toThrow(
        'another prompt'
      )
    } finally {
      expect(await session.close()).toBe(true)
      await expect(prompt).rejects.toThrow()
    }
  })

  it('rejects a foreign-session update even when a successful prompt response follows it', async () => {
    const observed = events()
    const session = await createCursorAcpSession({
      launch: launch(),
      cwd: tmpdir(),
      events: observed
    })
    try {
      await expect(session.prompt([{ type: 'text', text: 'wrong-session' }])).rejects.toThrow()
      expect(observed.update).not.toHaveBeenCalled()
    } finally {
      expect(await session.close()).toBe(true)
    }
  })

  it('rejects a different protocol version and reaps the child', async () => {
    await expect(openCursorAcpConnection(launch({ FIXTURE_BAD_VERSION: '1' }))).rejects.toThrow(
      'unsupported initialization'
    )
  })

  it('refuses a relative execution directory before starting a process', async () => {
    const openConnection = vi.fn(openCursorAcpConnection)
    await expect(
      createCursorAcpSession({
        launch: launch(),
        cwd: 'relative-folder',
        events: events(),
        openConnection
      })
    ).rejects.toThrow('absolute cwd')
    expect(openConnection).not.toHaveBeenCalled()
  })
})

import { afterEach, describe, expect, it } from 'vitest'
import type { ClaudeStructuredSessionAdapter } from '../claude-structured-session-adapter'
import {
  USER_MESSAGE,
  acquired,
  claudeWasSent,
  fakeClaude
} from '../claude-structured-session-test-support'

const owned: { claude: ReturnType<typeof fakeClaude>; adapter: ClaudeStructuredSessionAdapter }[] =
  []

/** A chat whose initialize reply adds `fields`; counts the `remote_control` requests it receives. */
async function openChat(
  fields: Record<string, unknown>,
  answer: () => Promise<unknown> = async () => ({})
) {
  let remoteControlRequests = 0
  const claude = fakeClaude()
  const open = claude.openConnection
  // The shared fake has neither the Remote Control initialize fields nor the request.
  claude.openConnection = async (...args) => {
    const connection = await open(...args)
    const read = connection.initializationResult
    connection.initializationResult = () => read().then((reply) => Object.assign({}, reply, fields))
    connection.enableRemoteControl = () => {
      remoteControlRequests += 1
      return answer()
    }
    return connection
  }
  const adapter = await acquired(claude)
  owned.push({ claude, adapter })
  const connection = claude.connections[0]
  if (!connection) {
    throw new Error('expected Claude connection')
  }
  return { adapter, connection, remoteControlRequests: () => remoteControlRequests }
}

afterEach(async () => {
  for (const { claude, adapter } of owned.splice(0)) {
    claude.dispose()
    await adapter.closeAll()
  }
})

describe('Claude chat Remote Control', () => {
  it("connects on the user's own auto-connect setting, not on an org default alone", async () => {
    const own = await openChat({ remote_control_auto_enable: true })
    const orgDefault = await openChat({
      remote_control_auto_enable: true,
      remote_control_auto_on_by_default: true
    })

    expect([own.remoteControlRequests(), orgDefault.remoteControlRequests()]).toEqual([1, 0])
  })

  it('keeps the chat working when Claude refuses Remote Control', async () => {
    const { adapter, connection, remoteControlRequests } = await openChat(
      { remote_control_auto_enable: true },
      () => Promise.reject(new Error('Remote Control is disabled by your organization'))
    )

    await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'client-turn-1',
      body: USER_MESSAGE,
      fence: 7
    })

    expect(remoteControlRequests()).toBe(1)
    expect(claudeWasSent(connection, 'ship it')).toBe(true)
  })

  it('keeps the chat working while Remote Control has not answered', async () => {
    const pending = Promise.withResolvers<unknown>()
    const { adapter, connection, remoteControlRequests } = await openChat(
      { remote_control_auto_enable: true },
      () => pending.promise
    )

    await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'client-turn-1',
      body: USER_MESSAGE,
      fence: 7
    })

    expect(remoteControlRequests()).toBe(1)
    expect(claudeWasSent(connection, 'ship it')).toBe(true)
    pending.resolve({})
  })
})

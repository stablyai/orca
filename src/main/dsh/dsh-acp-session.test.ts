import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDshAcpSession, type DshAcpSession } from './dsh-acp-session'
import { DshAcpOptions } from './dsh-acp-options'
import { DSH_ACP_PEER } from './dsh-acp-peer.test-fixture'

const sessions: DshAcpSession[] = []
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()))
})
async function open() {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-acp-peer-')))
  const options = new DshAcpOptions()
  const updates: string[] = []
  const requests: { id: string | number; method: string; params: unknown }[] = []
  const session = await createDshAcpSession({
    launch: { command: process.execPath, args: ['-e', DSH_ACP_PEER], cwd },
    cwd,
    events: {
      ready: (_id, _connection, state) => options.state(state),
      update: (update) => {
        updates.push(update.sessionUpdate)
        options.update(update)
      },
      request: (request) => {
        requests.push(request)
      }
    }
  })
  sessions.push(session)
  return { session, options, updates, requests, cwd }
}

describe('official ACP session controls against a scripted peer', () => {
  it('orders updates before completion and permits only one in-flight prompt', async () => {
    const { session, updates, requests } = await open()
    const pending = session.prompt([{ type: 'text', text: 'fixture' }])
    expect(() => session.prompt([{ type: 'text', text: 'second' }])).toThrow('another prompt')
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    session.connection.respond(700, { outcome: { outcome: 'selected', optionId: 'reject-1' } })
    await expect(pending).resolves.toBe('end_turn')
    expect(updates).toEqual([
      'agent_thought_chunk',
      'agent_message_chunk',
      'agent_message_chunk',
      'tool_call',
      'tool_call_update',
      'usage_update'
    ])
    expect(session.phase).toBe('ready')
  })
  it('takes dynamic grouped models and offered reasoning choices from ACP', async () => {
    const { session, options } = await open()
    expect(options.read().models[0]?.efforts).toEqual([
      { value: 'fixture-calm', label: 'Calm' },
      { value: 'fixture-deep', label: 'Deep' }
    ])
    await options.set(session.connection, session.sessionId, 'model', 'fixture-alternative')
    await options.set(session.connection, session.sessionId, 'effort', 'fixture-deep')
    expect(options.read().current).toMatchObject({
      model: 'fixture-alternative',
      effort: 'fixture-deep',
      confirmed: ['model', 'effort']
    })
    await expect(
      options.set(session.connection, session.sessionId, 'effort', 'invented')
    ).rejects.toThrow('did not offer')
  })
  it('cancels a live prompt and proves process exit on close', async () => {
    const { session } = await open()
    const pending = session.prompt([{ type: 'text', text: 'hold' }])
    await expect(session.cancel()).resolves.toBe(true)
    await expect(pending).resolves.toBe('cancelled')
    await expect(session.close()).resolves.toBe(true)
    expect(session.connection.closed).toBe(true)
  })
  it.each(['test/malformed', 'test/oversized', 'test/wrong-session'])(
    'rejects corrupt or foreign traffic: %s',
    async (method) => {
      const { session, updates } = await open()
      session.connection.notify(method)
      await vi.waitFor(() => expect(session.connection.closed).toBe(true))
      expect(updates).toEqual([])
      await expect(session.close()).resolves.toBe(true)
    }
  )
  it('surfaces a provider refusal and closes its failed transport', async () => {
    const { session } = await open()
    await expect(session.prompt([{ type: 'text', text: 'refuse' }])).rejects.toThrow(
      'fixture refused'
    )
    await expect(session.close()).resolves.toBe(true)
  })
})

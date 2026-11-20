import { resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ORCA_AGENT_SESSION_ID_ENV } from '../../shared/agent-session/lifecycle/launch/agent-session-caller-env'
import { REPEATED_FLAG_SEPARATOR } from '../arguments/args'
import { BOT_ITEM_HANDLERS } from './bot-items'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

it('sends each --file by its full path from the caller folder, and files alone make a comment', async () => {
  vi.stubEnv(ORCA_AGENT_SESSION_ID_ENV, 'session-1')
  vi.spyOn(console, 'log').mockImplementation(() => {})
  const call = vi.fn(async () => ({ ok: true, result: { item: null, eventId: 'e4' } }))

  await BOT_ITEM_HANDLERS['bot item comment']({
    flags: new Map([
      ['id', '3'],
      ['file', ['shots/after.png', '/tmp/run.log'].join(REPEATED_FLAG_SEPARATOR)]
    ]),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler uses only client.call, supplied here.
    client: { call } as never,
    cwd: '/work/repo',
    json: true
  })

  expect(call).toHaveBeenCalledWith('bots.items.comment', {
    callerSessionId: 'session-1',
    item: '3',
    text: '',
    files: [resolve('/work/repo/shots/after.png'), resolve('/tmp/run.log')]
  })
})

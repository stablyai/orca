import { describe, expect, it } from 'vitest'
import { BOT_CREATE_HANDLERS } from './bot-create'

function makeContext(entries: Record<string, string | boolean>, isRemote = false) {
  return {
    flags: new Map<string, string | boolean>(Object.entries(entries)),
    json: true,
    client: {
      isRemote,
      call: async () => {
        throw new Error('unexpected RPC call')
      }
    }
  } as never
}

describe('orca bot create validation', () => {
  it('refuses paired/remote targets before issuing any RPC', async () => {
    await expect(
      BOT_CREATE_HANDLERS['bot create'](
        makeContext({ name: 'Triage', purpose: 'Triage bugs.' }, true)
      )
    ).rejects.toThrow(/local Orca/)
  })

  it('rejects unknown --agent values and --agent combined with --offer', async () => {
    await expect(
      BOT_CREATE_HANDLERS['bot create'](
        makeContext({ name: 'Triage', purpose: 'Triage bugs.', agent: 'not-an-agent' })
      )
    ).rejects.toThrow(/--agent is one of:/)

    await expect(
      BOT_CREATE_HANDLERS['bot create'](
        makeContext({ offer: true, name: 'Triage', purpose: 'Triage bugs.', agent: 'codex' })
      )
    ).rejects.toThrow(/without --offer/)
  })
})

import { describe, expect, it } from 'vitest'
import { botsListRead } from './host-bots-operations'

function read(extra: Record<string, unknown> = {}) {
  return botsListRead.interpret({
    id: '1',
    ok: true,
    result: {
      bots: [],
      botsEnabled: true,
      hideBotCreatedWorkspaces: false,
      ...extra
    }
  })
}

describe('bots.list connector status', () => {
  it('keeps the host connector status and leaves it off for an older host', () => {
    expect(read({ connectorStatus: 'signed-out' })).toMatchObject({
      accepted: true,
      value: { connectorStatus: 'signed-out' }
    })
    expect(read()).toMatchObject({
      accepted: true,
      value: { connectorStatus: undefined }
    })
    expect(read({ connectorStatus: 'not-a-status' })).toMatchObject({
      accepted: true,
      value: { connectorStatus: undefined }
    })
  })
})

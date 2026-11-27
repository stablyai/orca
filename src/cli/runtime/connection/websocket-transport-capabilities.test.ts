import { describe, expect, it } from 'vitest'
import { BOTS_ITEM_WAITING_CAPABILITY } from '../../../shared/bot-runtime-capabilities'
import { CLI_CLIENT_CAPABILITIES } from './websocket-transport'

describe('the paired CLI', () => {
  // Without it a paired host prints Waiting items as in_progress, and the agent is misled.
  it('reads Waiting items', () => {
    expect(CLI_CLIENT_CAPABILITIES).toContain(BOTS_ITEM_WAITING_CAPABILITY)
  })
})

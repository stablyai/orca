import { describe, expect, it } from 'vitest'
import { MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY } from '../../../src/shared/remote-runtime/relay/mobile-desktop-relay-contract'
import { FakeSession } from '../transport/connection/mobile-endpoint-supervisor-test-fakes'
import { newBotTargetClient } from './new-bot-target-client'

describe('the client a new bot is made through', () => {
  const client = new FakeSession('connected')
  const base = { client, hostCapabilities: [MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY] }

  it('is the paired desktop’s for its own Bots section, and the server’s for a server’s', () => {
    expect(newBotTargetClient({ ...base, target: 'local', servers: [] })).toBe(client)
    const server = newBotTargetClient({
      ...base,
      target: 'runtime:s1',
      servers: [{ hostId: 'runtime:s1' }]
    })
    expect(server).not.toBeNull()
    expect(server).not.toBe(client)
  })

  // Falling back would make the bot on the paired desktop instead.
  it('is none once the server drops out while the sheet is open, so Create stays off', () => {
    expect(newBotTargetClient({ ...base, target: 'runtime:s1', servers: [] })).toBeNull()
    expect(newBotTargetClient({ ...base, target: null, servers: [] })).toBeNull()
  })
})

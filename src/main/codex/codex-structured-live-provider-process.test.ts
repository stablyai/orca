import { describe, expect, it } from 'vitest'
import { adapterFor, fakeCodex, identityFor } from './codex-structured-session-adapter-fixture'

describe('Codex adapter liveness for lease renewal', () => {
  it('holds its acquisition until the connection reports the root exit', async () => {
    const codex = fakeCodex()
    const adapter = adapterFor(codex)
    const { acquisitionGeneration } = await adapter.acquire({
      identity: identityFor('session-1'),
      fence: 7,
      spawnToken: 'spawn-9'
    })

    expect(adapter.holdsLiveProviderProcess('session-1', acquisitionGeneration!)).toBe(true)
    expect(adapter.holdsLiveProviderProcess('session-1', 'another-acquisition')).toBe(false)

    codex.connections[0]!.handlers.onExit?.(new Error('codex app-server exited'))
    expect(adapter.holdsLiveProviderProcess('session-1', acquisitionGeneration!)).toBe(false)
  })
})

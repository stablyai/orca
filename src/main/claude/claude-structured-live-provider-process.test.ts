import { describe, expect, it } from 'vitest'
import {
  adapterFor,
  fakeClaude,
  identityFor,
  recordingJournalSink
} from './claude-structured-session-test-support'

describe('Claude adapter liveness for lease renewal', () => {
  it('holds its acquisition until the root exit is seen', async () => {
    const claude = fakeClaude()
    const adapter = adapterFor(claude)
    const { acquisitionGeneration } = await adapter.acquire({
      identity: identityFor(),
      fence: 7,
      spawnToken: 'spawn-9',
      events: recordingJournalSink()
    })

    expect(adapter.holdsLiveProviderProcess('session-1', acquisitionGeneration!)).toBe(true)
    expect(adapter.holdsLiveProviderProcess('session-1', 'another-acquisition')).toBe(false)
    expect(adapter.holdsLiveProviderProcess('session-2', acquisitionGeneration!)).toBe(false)

    // The connection's own observation, before any exit event reaches the host.
    claude.connections[0]!.exitVerdict = { root: 'exited', tree: 'unverifiable' }
    expect(adapter.holdsLiveProviderProcess('session-1', acquisitionGeneration!)).toBe(false)
  })
})

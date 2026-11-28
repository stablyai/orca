// Guards #51086: a kept agent's handed-back token and caller go when its relay ends on its daemon
// start, without a reconnect, while the agents still running keep theirs.
import { describe, expect, it } from 'vitest'
import { DaemonClient } from '../../daemon/transport/client/daemon-client'
import type { ToolRelayFrontKeptRelay } from '../../daemon/protocol/daemon-tool-relay-front-protocol'
import { sharedToolProcessCaller } from '../../runtime/agent-session/environment/shared-tool-process-callers'
import { KeptRelayGrants } from './bot-tool-relay-kept-grants'

const N = 1_000

/** One bot's agents, launched by earlier runs of Orca, each run with its own token. */
function relay(index: number): ToolRelayFrontKeptRelay {
  return {
    relayId: `r-${index}`,
    chatKey: `chat-${index}`,
    grants: [{ owner: 'scout', token: `grant-${index}`, folders: { bot: '/bots/scout' } }],
    caller: { owner: 'scout', token: `caller-${index}`, caller: { CHAT: `chat-${index}` } }
  }
}

describe('kept relays ending', () => {
  it('drops each ended relay’s token and caller at once, and keeps what live relays hold', () => {
    const kept = new KeptRelayGrants(async () => null)
    const client = new DaemonClient({ socketPath: '/nowhere.sock', tokenPath: '/nowhere.token' })
    kept.adopt(
      client,
      Array.from({ length: N }, (_, index) => relay(index))
    )
    // The first one adopted is the bot's token for this run; the rest go as their agents end.
    for (let index = 1; index < N; index += 1) {
      kept.keptEnded(client, `r-${index}`)
    }
    for (let index = 1; index < N; index += 1) {
      expect(kept.of(`grant-${index}`)).toBeUndefined()
      expect(sharedToolProcessCaller(`caller-${index}`)).toBeNull()
    }
    expect(kept.of('grant-0')?.owner).toBe('scout')
    expect(sharedToolProcessCaller('caller-0')).toEqual({ CHAT: 'chat-0' })

    kept.keptEnded(client, 'r-0')
    expect(sharedToolProcessCaller('caller-0')).toBeNull()
    kept.close()
  })
})

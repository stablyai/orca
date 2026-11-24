import type { ProviderRelayAttachResult } from '../daemon/protocol/daemon-provider-relay-protocol'
import type { ProviderRelayChannel, ProviderRelaySink } from './provider-relay-channel'

/** An attach that replays nothing and holds no request, for tests to override. */
export const EMPTY_RELAY_ATTACH: ProviderRelayAttachResult = {
  replayThroughSeq: 0,
  pending: [],
  maxClientRequestId: null,
  initializeResultSent: false,
  stderrTail: '',
  exit: null
}

/** One relay's daemon channel; `sink()` is what the child bound, for the test to send events on. */
export function fakeProviderRelayChannel(members: {
  attach: () => Promise<ProviderRelayAttachResult>
  ack?: (relayId: string, seq: number, keepFrom?: number) => Promise<unknown>
}): { channel: ProviderRelayChannel; sink: () => ProviderRelaySink } {
  let bound: ProviderRelaySink | null = null
  const fake = {
    bind: (_relayId: string, sink: ProviderRelaySink) => {
      bound = sink
      return () => {}
    },
    attach: members.attach,
    ack: members.ack ?? (async () => ({})),
    close: async () => ({})
  }
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a relayed child calls only these four members
    channel: fake as unknown as ProviderRelayChannel,
    sink: () => {
      if (!bound) {
        throw new Error('The child has not bound its relay yet')
      }
      return bound
    }
  }
}

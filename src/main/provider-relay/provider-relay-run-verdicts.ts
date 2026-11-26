import { cancelProviderRelayExitProbes } from './provider-relay-exit-probes'

// Each chat's undecided-run verdict and the asks that may change it: an ask's verdict counts only
// if no close, deletion, new run or newer answer fenced it off since it began.

/** Chats whose current run's daemon start couldn't say at their newest applied ask. */
const unknownRuns = new Set<string>()
let askSeq = 0
/**
 * Per chat with an ask in flight: how many, and the newest ask a later answer, close, deletion or
 * new run fenced off. An ask's verdict applies only when it started after that floor.
 */
const asks = new Map<
  string,
  { inFlight: number; floor: number; unknownFloor: number; fence: number }
>()

/** Starts one ask; its number is passed back with its verdict. */
export function beginProviderRelayRunAsk(chatKey: string): number {
  const ask = asks.get(chatKey) ?? { inFlight: 0, floor: 0, unknownFloor: 0, fence: 0 }
  ask.inFlight += 1
  asks.set(chatKey, ask)
  askSeq += 1
  return askSeq
}

/** Ends one ask; a thrown ask (null) or one older than the floor leaves the verdict as it was. */
export function noteProviderRelayRunVerdict(
  chatKey: string,
  seq: number,
  verdict: 'kept' | 'gone' | 'unknown' | null
): void {
  const ask = asks.get(chatKey)
  if (!ask) {
    return
  }
  if (verdict === 'unknown' && seq > ask.floor && seq > ask.unknownFloor) {
    ask.floor = seq
    unknownRuns.add(chatKey)
  } else if ((verdict === 'kept' || verdict === 'gone') && seq > ask.floor) {
    ask.floor = seq
    if (verdict === 'gone') {
      // The run is over: an older ask still reading its relay must not place it.
      ask.fence = askSeq
    }
    // No ask already in flight can undo this answer with an unknown.
    ask.unknownFloor = askSeq
    unknownRuns.delete(chatKey)
    cancelProviderRelayExitProbes(chatKey)
  }
  ask.inFlight -= 1
  if (ask.inFlight <= 0) {
    asks.delete(chatKey)
  }
}

/** The ask may still end as unknown: no fence and no conclusive answer since it started. */
export function providerRelayRunAskAwaitsProof(chatKey: string, seq: number): boolean {
  const ask = asks.get(chatKey)
  return ask !== undefined && seq > ask.floor && seq > ask.unknownFloor
}

/** No close, deletion or new run since the ask began (a newer answer about the same run is fine). */
export function providerRelayRunAskUnfenced(chatKey: string, seq: number): boolean {
  const ask = asks.get(chatKey)
  return ask !== undefined && seq > ask.fence
}

export function providerRelayRunAskCurrent(chatKey: string, seq: number): boolean {
  const ask = asks.get(chatKey)
  return ask !== undefined && seq > ask.floor
}

/** The chat isn't open and nothing asks about it now: its undecided run is forgotten; asks in flight stand. */
export function forgetIdleProviderRelayRunVerdict(chatKey: string): void {
  if (!asks.has(chatKey)) {
    unknownRuns.delete(chatKey)
    cancelProviderRelayExitProbes(chatKey)
  }
}

/** Its chat closed or was deleted, or a new run replaced the one asked about. */
export function forgetProviderRelayRunVerdict(chatKey: string): void {
  unknownRuns.delete(chatKey)
  cancelProviderRelayExitProbes(chatKey)
  const ask = asks.get(chatKey)
  if (ask) {
    ask.floor = askSeq
    ask.fence = askSeq
  }
}

/** Its daemon start couldn't say at the last ask; the host holds the chat until it can. */
export function providerRelayRunUnknown(chatKey: string): boolean {
  return unknownRuns.has(chatKey)
}

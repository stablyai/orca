import { parseAppSshPtyId } from '../providers/ssh-pty-id'

type HeadlessCatchUpRuntime = {
  hasHeadlessTerminal: (ptyId: string) => boolean
  appendHeadlessTerminalCatchUp: (
    ptyId: string,
    data: string,
    ingestedSequenceFence: number
  ) => boolean
}

/**
 * The model's ingest sequence as it stood immediately BEFORE an attach RPC was issued.
 *
 * Only `capturePtyModelIngestFence`, called on the line before the `provider.spawn` that produces
 * the replay, may mint one; it then travels WITH the attach result so no later reader can mistake a
 * post-attach sequence (already advanced by live bytes) for a pre-attach one.
 */
export type PtyModelIngestFence = {
  readonly ptyId: string
  readonly sequence: number
  /** Why mutable: deduped adoptions hand one attach result to several callers; the tail is theirs once. */
  consumed?: boolean
}

/** MUST be called on the line before the attach RPC — a fence read after it proves nothing. */
export function capturePtyModelIngestFence(
  runtime: { getPtyOutputSequence?: (ptyId: string) => number } | null | undefined,
  ptyId: string | undefined
): PtyModelIngestFence | null {
  if (!ptyId) {
    return null
  }
  // Why not `?? 0`: a runtime that cannot report its ingest sequence cannot prove ordering either.
  const sequence = runtime?.getPtyOutputSequence?.(ptyId)
  return typeof sequence === 'number' ? { ptyId, sequence } : null
}

/**
 * Close the one hole in main's terminal model: the relay's reattach replay.
 *
 * Every other SSH byte enters the model through acceptPtyData, but attach hands its replay to the
 * client as an RPC payload AND deletes the still-queued bytes from the publish queue, so those
 * bytes never reach main at all. Appending that exact suffix here keeps the model from drifting
 * permanently short — which is what made a later park-reveal repaint a frame stale by the outage,
 * and what made the reconnect paint gate read `alternateScreen` off a model that never saw the
 * app leave the alternate screen.
 *
 * DELIBERATELY NOT a coverage proof, and nothing downstream is told it is: `replayUnseenChars`
 * names what THIS attach withholds, not what the whole tail-from-spawn replay contains, so bytes an
 * earlier attach dropped or bytes that predate this emulator stay unaccounted. Sizing the overlap by
 * matching bytes is deliberately not attempted either: repeated TUI frames alias, so a near-miss
 * silently duplicates or drops a frame.
 *
 * Returns whether a catch-up write was issued (the seed above, or a fully-delivered replay, needs
 * none).
 */
export function applySshReattachReplayModelCatchUp(args: {
  runtime: HeadlessCatchUpRuntime | null | undefined
  ptyId: string
  isReattach: boolean
  replay: string | undefined
  replayUnseenChars: number | undefined
  /** The fresh-emulator seed above already wrote this exact replay (post-relaunch attach). */
  seededFromReplay: boolean
  /**
   * The fence minted beside the attach RPC that produced `replay`. The withheld tail predates every
   * byte the relay published after that RPC, so the append is only ordered while nothing has been
   * ingested since; a missing fence — no attach of ours, or a deduped one already ingested — can
   * never be proven and refuses.
   */
  modelIngestFence: PtyModelIngestFence | null | undefined
}): boolean {
  const unseen = args.replayUnseenChars
  const fence = args.modelIngestFence
  if (
    !args.isReattach ||
    !args.replay ||
    args.seededFromReplay ||
    !args.runtime ||
    unseen === undefined ||
    unseen <= 0 ||
    unseen > args.replay.length ||
    !fence ||
    fence.consumed === true ||
    fence.ptyId !== args.ptyId
  ) {
    return false
  }
  // Why gated on the SSH id: folder-workspace and other remote-runtime PTYs reuse this handler, and
  // their replay never took the relay's around-the-model route.
  if (parseAppSshPtyId(args.ptyId) === null || !args.runtime.hasHeadlessTerminal(args.ptyId)) {
    return false
  }
  fence.consumed = true
  return args.runtime.appendHeadlessTerminalCatchUp(
    args.ptyId,
    args.replay.slice(-unseen),
    fence.sequence
  )
}

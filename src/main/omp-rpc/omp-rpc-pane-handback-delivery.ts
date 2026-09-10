// Why a PTY hand-back is RETAINED, not just pushed (XLR-R7-001, cross-lab
// review). The instruction to recreate a pane's PTY is the only thing that
// exists once a release completes: main has already deleted the RPC session,
// so the pane's adoption probe (`ompRpcChat:hasSession`) answers "no session"
// and the pane is left with neither RPC ownership nor a terminal. A
// `webContents.send` is fire-and-forget — main cannot learn whether it landed
// — and a renderer that reloaded, or whose durable listener was momentarily
// absent, dropped that one instruction permanently.
//
// So the push became a NUDGE and this module holds the instruction until
// someone proves they used it. A claim LEASES the instruction; only
// `settleOmpRpcPaneHandback` with `respawned: true` discards it (XLR-R8-001).
// Deleting at claim time made the hand-back neither reload- nor
// failure-durable: a renderer that reloaded, unmounted, or whose `pty.spawn`
// rejected between the claim and the respawn left the pane with neither RPC
// ownership nor a terminal, and nothing ever revisited it.
//
// The lease is also what keeps the nudge safe to broadcast: N nudges (the
// renderer's bounded cleanup fires several releases that all JOIN main's
// single-flight release), or several windows' listeners, still respawn exactly
// one PTY, because only one lease is outstanding at a time. A pane whose
// renderer is gone keeps its retained instruction for the next mount to claim.

import { webContents } from 'electron'
import type {
  OmpRpcChatClaimedHandback,
  OmpRpcChatHandbackPayload,
  OmpRpcChatSettleHandbackArgs
} from '../../shared/omp-rpc-chat-ipc-contract'
import { parsePaneKey } from '../../shared/stable-pane-id'

/** Who is asking. The `webContents` id alone is NOT an identity (XLR-R9-001):
 *  the durable listener claims on mount AND on every nudge, so one live
 *  listener repeats its id. `documentId` is minted per page load in the preload
 *  — exactly the lifetime a lease must survive (a reload leaves no other
 *  signal) and must not (the same listener asking again mid-respawn). */
export type OmpRpcPaneHandbackClaimant = { webContentsId: number; documentId: string }

type RetainedHandback = {
  payload: OmpRpcChatHandbackPayload
  /** The claimant currently attempting the respawn, absent while unclaimed. */
  claim?: { claimant: OmpRpcPaneHandbackClaimant; token: string }
  /** A claim was refused while this lease was outstanding. A refusal produces
   *  no other signal for that claimant, so an un-respawned end must re-nudge. */
  reofferOnRelease?: boolean
  failedRespawnCount: number
}

const pendingByPaneKey = new Map<string, RetainedHandback>()
let claimSequence = 0
const MAX_IMMEDIATE_HANDBACK_RESPAWN_RETRIES = 3

function isSameHandback(a: OmpRpcChatHandbackPayload, b: OmpRpcChatHandbackPayload): boolean {
  return (
    a.paneKey === b.paneKey &&
    a.replacedPtyId === b.replacedPtyId &&
    a.cwd === b.cwd &&
    a.sessionId === b.sessionId
  )
}

function nudgeRenderers(payload: OmpRpcChatHandbackPayload): void {
  for (const contents of webContents.getAllWebContents()) {
    try {
      if (!contents.isDestroyed()) {
        contents.send('ompRpcChat:handback', payload)
      }
    } catch {
      // A renderer that died between the check and the send is exactly the case
      // the retained instruction covers; never fail the release for it.
    }
  }
}

/** Retains the hand-back for a later claim, then nudges every live renderer.
 *  A pane key no renderer could respawn into is not retained — `parsePaneKey`
 *  is the same gate `respawnPtyForOmpRpcChatHandback` applies, so an entry that
 *  fails it could never be claimed and would sit here for the app's life. */
export function publishOmpRpcPaneHandback(payload: OmpRpcChatHandbackPayload): void {
  const retained = pendingByPaneKey.get(payload.paneKey)
  if (parsePaneKey(payload.paneKey) && !(retained && isSameHandback(retained.payload, payload))) {
    // One per pane: a later hand-back for the same pane supersedes the previous
    // one, since it carries the newer proven session identity. The fresh entry
    // carries no claim, so an in-flight claimant's `settleHandback` no longer
    // matches and cannot discard the newer instruction.
    //
    // An IDENTICAL instruction is not a supersession though (XLR-R9-001): the
    // release is single-flight but the push is not, so N joined callers publish
    // the same payload. Replacing the entry dropped the outstanding lease and
    // handed the payload straight back to the claimant still respawning it —
    // two `omp --resume` children on one session file.
    pendingByPaneKey.set(payload.paneKey, { payload, failedRespawnCount: 0 })
  }
  nudgeRenderers(payload)
}

/** Whether a live claimant already holds this instruction.
 *
 *  A claim is a LEASE, not a consume (XLR-R8-001), so it has to end somewhere
 *  other than a settle that may never arrive. The two ways it ends without one
 *  are both proofs that the claimant can no longer be respawning:
 *
 *  - never merely a new document on the holder's `webContents`. Reloading
 *    destroys renderer JavaScript but cannot cancel a main-process PTY spawn
 *    that it already requested, so it is not proof the earlier lease ended.
 *  - a claimant whose `webContents` is gone. Its window closed mid-respawn, so
 *    another window's listener must be able to recover the pane.
 *
 *  Anything else — a live sibling window, or the holder itself, mid-respawn —
 *  is refused, because two `omp --resume` children on one session file is the
 *  single-writer overlap this feature is proof-gated to prevent. */
function isLeaseAvailable(entry: RetainedHandback, claimant: OmpRpcPaneHandbackClaimant): boolean {
  if (!entry.claim) {
    return true
  }
  const holder = entry.claim.claimant
  if (holder.webContentsId === claimant.webContentsId) {
    return holder.documentId !== claimant.documentId
  }
  return !webContents
    .getAllWebContents()
    .some((c) => c.id === holder.webContentsId && !c.isDestroyed())
}

/** Leases every retained hand-back belonging to `tabId` to the asking document.
 *  A missing `documentId` fails closed: without it a `webContents` id cannot
 *  tell a reload from the holder claiming again mid-respawn, and guessing wrong
 *  starts a second `omp --resume` against one session file. */
export function claimOmpRpcPaneHandbacks(
  tabId: string,
  webContentsId: number,
  documentId: string | undefined
): OmpRpcChatClaimedHandback[] {
  const claimantDocumentId = documentId?.trim()
  if (!claimantDocumentId) {
    return []
  }
  const claimant: OmpRpcPaneHandbackClaimant = { webContentsId, documentId: claimantDocumentId }
  const claimed: OmpRpcChatClaimedHandback[] = []
  for (const [paneKey, entry] of pendingByPaneKey) {
    if (parsePaneKey(paneKey)?.tabId !== tabId) {
      continue
    }
    if (!isLeaseAvailable(entry, claimant)) {
      // Refused, not lost: the holder can still end its lease un-respawned.
      entry.reofferOnRelease = true
      continue
    }
    claimSequence += 1
    entry.claim = { claimant, token: `handback-${claimSequence}` }
    claimed.push({ token: entry.claim.token, payload: entry.payload })
  }
  return claimed
}

/** Ends a lease. Only a respawn that actually happened discards the instruction;
 *  every other outcome returns it to the retained set for the next claim, since
 *  a pane with neither RPC ownership nor a PTY is what this module exists to
 *  prevent. Stale tokens are ignored: the lease they name is already over. */
export function settleOmpRpcPaneHandback(args: OmpRpcChatSettleHandbackArgs): void {
  const entry = pendingByPaneKey.get(args.paneKey)
  if (!entry || entry.claim?.token !== args.token) {
    return
  }
  if (args.respawned) {
    pendingByPaneKey.delete(args.paneKey)
    return
  }
  entry.claim = undefined
  if (entry.reofferOnRelease) {
    // A claim refused during this lease got no instruction and has no other
    // reason to look again; without this the pane keeps neither RPC ownership
    // nor a PTY until some future mount happens to claim.
    entry.reofferOnRelease = false
  }
  if (entry.failedRespawnCount >= MAX_IMMEDIATE_HANDBACK_RESPAWN_RETRIES) {
    return
  }
  entry.failedRespawnCount += 1
  nudgeRenderers(entry.payload)
}

/** Test-only: drop retained hand-backs between runs. */
export function clearOmpRpcPaneHandbacksForTests(): void {
  pendingByPaneKey.clear()
  claimSequence = 0
}

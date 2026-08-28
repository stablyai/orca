import type { Store } from '../persistence'
import type { IPtyProvider } from '../providers/types'
import { toAppSshPtyId, toRelaySshPtyId } from '../providers/ssh-pty-id'
import {
  decideSshPendingPtyKill,
  type SshPendingPtyKillEntry,
  type SshPendingPtyKillObservation,
  type SshPendingPtyKillRetirement
} from '../../shared/ssh-pending-pty-kill'

export type SshPendingPtyKillReplayArgs = {
  targetId: string
  store: Store
  provider: IPtyProvider
  shouldContinue: () => boolean
  now?: () => number
}

/** Stops issued per inventory read. Every stop in a wave is dispatched concurrently, immediately
 *  after the read that fenced it, so no kill is ever aimed with evidence older than one round trip. */
const REPLAY_WAVE_SIZE = 4

type HostInventory = Map<string, string | undefined>

/** Relay pty id -> the incarnation the host published for it, `undefined` when it published none. */
async function readHostInventory(args: SshPendingPtyKillReplayArgs): Promise<HostInventory> {
  const processes = await args.provider.listProcesses()
  const inventory: HostInventory = new Map()
  for (const process of processes) {
    inventory.set(toRelaySshPtyId(args.targetId, process.id), process.incarnationId)
  }
  return inventory
}

/** Retires one order.
 *
 *  Both tombstoning reasons are derived from a successful `pty.listProcesses`, never from an error
 *  predicate: `isPtyAlreadyGoneError` matches on message text (`/Session not found/i`), which a
 *  transport failure could wear, and a tombstone written on that would bury a live remote shell.
 *  A recycled id gets `expired`, not `terminated` — the client has lost its route to that lease,
 *  which is all that was observed; nothing says the shell it named ever died. */
function retire(
  args: SshPendingPtyKillReplayArgs,
  relayPtyId: string,
  reason: SshPendingPtyKillRetirement
): void {
  args.store.clearSshRemotePtyKillIntent(args.targetId, relayPtyId)
  if (reason === 'host-reports-absent' || reason === 'stop-confirmed') {
    args.store.markSshRemotePtyLease(args.targetId, relayPtyId, 'terminated')
  } else if (reason === 'relay-id-recycled') {
    // Why this must happen: the reattach one step later filters on lease state and fences only on
    // paneKey/tabId, never on incarnation. Leaving this lease active hands the user's old pane to
    // whatever process now holds the recycled id.
    args.store.markSshRemotePtyLease(args.targetId, relayPtyId, 'expired')
  }
  console.log(
    `[ssh-pending-kill] retired stop for ${args.targetId}/${relayPtyId} (${reason.replace(/-/g, ' ')})`
  )
}

function observe(inventory: HostInventory, relayPtyId: string): SshPendingPtyKillObservation {
  return {
    hostListsPty: inventory.has(relayPtyId),
    hostIncarnationId: inventory.get(relayPtyId)
  }
}

/** Applies every recorded order against one inventory, and returns the ones it says are safe to
 *  stop. Retirement side effects happen here, against that same fresh evidence. */
function selectReplayTargets(
  args: SshPendingPtyKillReplayArgs,
  inventory: HostInventory,
  now: number,
  /** Orders already dispatched this pass. Skipped whole: the shutdown they were issued is what
   *  removes them from the next inventory, so re-deciding would retire them a second time. */
  attempted: ReadonlySet<string>
): SshPendingPtyKillEntry[] {
  const replayable: SshPendingPtyKillEntry[] = []
  for (const entry of args.store.getSshRemotePtyKillIntents(args.targetId, now)) {
    if (attempted.has(entry.ptyId)) {
      continue
    }
    const decision = decideSshPendingPtyKill(entry.intent, observe(inventory, entry.ptyId), now)
    if (decision.action === 'retire') {
      retire(args, entry.ptyId, decision.reason)
    } else if (decision.action === 'defer') {
      console.warn(
        `[ssh-pending-kill] deferring stop for ${args.targetId}/${entry.ptyId}: ${decision.reason}`
      )
    } else {
      replayable.push(entry)
    }
  }
  return replayable
}

/** Issues one recorded stop. Returns false when it did not reach the host, in which case the order
 *  stays: a rejected RPC observes nothing, and the next handshake's inventory will answer.
 *
 *  Re-checks the fence here rather than trusting the selection pass, so the identity proof and the
 *  irreversible call sit next to each other and cannot drift apart if this loop is ever reshaped.
 *  It still cannot be made atomic — `pty.shutdown` carries no incarnation, so only the host could
 *  refuse a stale kill. See the residual risk note in the PR. */
async function deliverReplay(
  args: SshPendingPtyKillReplayArgs,
  entry: SshPendingPtyKillEntry,
  inventory: HostInventory,
  now: number
): Promise<boolean> {
  if (
    decideSshPendingPtyKill(entry.intent, observe(inventory, entry.ptyId), now).action !== 'replay'
  ) {
    return false
  }
  args.store.noteSshRemotePtyKillReplayAttempt(args.targetId, entry.ptyId)
  try {
    await args.provider.shutdown(toAppSshPtyId(args.targetId, entry.ptyId), { immediate: true })
    return true
  } catch (err) {
    console.warn(
      `[ssh-pending-kill] replay for ${args.targetId}/${entry.ptyId} is unverifiable: ${
        err instanceof Error ? err.message : String(err)
      }`
    )
    return false
  }
}

/** Confirms delivered stops against one fresh inventory.
 *
 *  Why re-list at all: the relay answers `pty.shutdown` for a PTY it never had with the same empty
 *  success, so a resolved RPC alone is not a death certificate. Absence from a live listing is. */
async function confirmDelivered(
  args: SshPendingPtyKillReplayArgs,
  awaitingProof: readonly string[]
): Promise<void> {
  if (awaitingProof.length === 0) {
    return
  }
  const inventory = await readHostInventory(args)
  for (const relayPtyId of awaitingProof) {
    if (!inventory.has(relayPtyId)) {
      retire(args, relayPtyId, 'stop-confirmed')
    } else {
      console.warn(
        `[ssh-pending-kill] ${args.targetId}/${relayPtyId} is still live after a replayed stop`
      )
    }
  }
}

/** Replays every stop this client could not deliver to `targetId`, now that it is reachable again.
 *
 *  Runs before reattach so a PTY that dies here is never re-adopted as a live pane. Costs nothing
 *  when nothing is pending. When something is, it re-reads the inventory once per wave rather than
 *  once per batch: the fence and the stops it authorises are then never more than one round trip
 *  apart, which is as tight as this can get while `pty.shutdown` carries no incarnation of its own.
 *
 *  Never throws. It is best-effort work on the connect path, and `establish()` treats a throw here
 *  as a failed connection. */
export async function replayPendingSshPtyKills(args: SshPendingPtyKillReplayArgs): Promise<void> {
  const now = args.now ?? Date.now
  try {
    // Inside the guard with everything else: these touch persistence, and a disk hiccup must not
    // turn best-effort cleanup into a failed SSH connection.
    args.store.pruneExpiredSshRemotePtyKillIntents(args.targetId, now())
    if (args.store.getSshRemotePtyKillIntents(args.targetId, now()).length === 0) {
      return
    }
    const attempted = new Set<string>()
    const awaitingProof: string[] = []
    while (args.shouldContinue()) {
      // No inventory means no fence, and an unfenced replay can kill a shell nobody asked to close.
      const inventory = await readHostInventory(args)
      const selected = selectReplayTargets(args, inventory, now(), attempted)
      const wave = selected.slice(0, REPLAY_WAVE_SIZE)
      if (wave.length === 0) {
        break
      }
      for (const entry of wave) {
        attempted.add(entry.ptyId)
      }
      const delivered = await Promise.all(
        wave.map(async (entry) =>
          (await deliverReplay(args, entry, inventory, now())) ? entry.ptyId : null
        )
      )
      for (const relayPtyId of delivered) {
        if (relayPtyId !== null) {
          awaitingProof.push(relayPtyId)
        }
      }
      if (selected.length <= REPLAY_WAVE_SIZE) {
        // This wave took everything the inventory offered, so another read would only confirm that.
        break
      }
    }
    if (args.shouldContinue()) {
      await confirmDelivered(args, awaitingProof)
    }
  } catch (err) {
    console.warn(
      `[ssh-pending-kill] replay pass on ${args.targetId} stopped early; stops stay pending: ${
        err instanceof Error ? err.message : String(err)
      }`
    )
  }
}

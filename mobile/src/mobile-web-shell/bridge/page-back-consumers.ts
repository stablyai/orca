/** Returns true when it acted on the press. False hands it on, exactly as a native `BackHandler`
 *  listener does. */
export type PageBackConsumer = () => boolean

/**
 * Who in this document is holding the device Back key, newest first.
 *
 * One stack per page client, because the key is one key: the sheets, the drawer, the unsaved-draft
 * prompts and the in-page router all claim through here, and the shell is told once — a claim
 * arrives when the first of them takes it and is let go when the last of them drops it, so the
 * shell's key registration does not flicker as one sheet opens over another.
 *
 * LIFO and `false`-falls-through, which is React Native's own rule for the key: the topmost thing
 * on screen answers first, and one that decides the press was not its own hands it back.
 */
export type PageBackConsumers = {
  /** Claims the key until the dispose is called. Disposing twice does nothing. */
  readonly claim: (consumer: PageBackConsumer) => () => void
  /** One press, offered newest first, and handed back to the shell when nothing here took it. */
  readonly press: () => void
  /**
   * Says the claim again, without an edge to hang it on.
   *
   * The shell forgets on purpose: it drops the claim on every `ready`, and a host rebuilt under a
   * live page starts with none at all. A claim taken before that shell arrived is one it never
   * heard, so the page answers each `init` with the state rather than with a transition.
   *
   * Nothing is said while nothing is held. Every `init` that answers a `ready` comes from a host
   * that dropped the claim first, so it already holds false; the only other one carries a
   * rewritten route, where a stale true needs a `false` the page posted to have never left — and
   * a port that refused that frame refuses this one too.
   */
  readonly reassert: () => void
  /** The client is closing: the key is the shell's own again. */
  readonly clear: () => void
}

export function createPageBackConsumers(args: {
  /** Told on each edge — the stack emptying or stopping being empty, never per consumer — and
   *  again for each `reassert`. */
  publishClaim: (claimed: boolean) => void
  /** Nothing here took the press. The claim and the press cross on separate frames, so a sheet
   *  that closed between the two must not leave the key doing nothing at all. */
  onUnclaimed: () => void
}): PageBackConsumers {
  const held: { consumer: PageBackConsumer }[] = []

  function publish(before: number): void {
    if ((before === 0) !== (held.length === 0)) {
      args.publishClaim(held.length > 0)
    }
  }

  return {
    claim: (consumer) => {
      const entry = { consumer }
      const before = held.length
      held.push(entry)
      publish(before)
      return () => {
        const at = held.indexOf(entry)
        if (at === -1) {
          return
        }
        const heldBefore = held.length
        held.splice(at, 1)
        publish(heldBefore)
      }
    },
    // A copy is walked, not the array: a consumer that closes its own sheet disposes itself from
    // inside this loop, and splicing under the iteration would skip the one beneath it.
    press: () => {
      if (!held.toReversed().some((entry) => entry.consumer())) {
        args.onUnclaimed()
      }
    },
    reassert: () => {
      if (held.length > 0) {
        args.publishClaim(true)
      }
    },
    clear: () => {
      const before = held.length
      held.length = 0
      publish(before)
    }
  }
}

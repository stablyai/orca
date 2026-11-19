export type PageBackConsumer = () => boolean

// One LIFO stack per page client matches native BackHandler false-fallthrough. Publish shell claim changes only on empty/nonempty edges so stacked sheets cannot flicker native key registration.
export type PageBackConsumers = {
  readonly claim: (consumer: PageBackConsumer) => () => void
  readonly press: () => void
  // Reassert held state after init because ready clears the shell claim; when unheld, its false state is already established and needs no extra frame.
  readonly reassert: () => void
  readonly clear: () => void
}

export function createPageBackConsumers(args: {
  // Publish empty/nonempty edges and held reassertions, not each consumer’s lifetime.
  publishClaim: (claimed: boolean) => void
  // Return an unhandled press to native navigation; a sheet may have closed after claiming it.
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
    // Walk a copy so a handler disposing itself cannot skip the consumer beneath it.
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

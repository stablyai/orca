import type { StagedGeneration } from './generation-store'

// A mounted page reading its host's active build.
export type GenerationHold = {
  release(): void
  // The page's answer for one resume round; any page unsafe clears every answer for the host.
  answer(round: number, safe: boolean): void
  // The app left the foreground: every answer for the host is stale.
  withdraw(): void
}

// How a held page reloads, how to ask its host's pages again in a fresh round right before that, and the
// latest round any page was asked.
export type GenerationReader = { swap(): void; askAgain(): number; latestRound(): number }

type Reader = GenerationReader & { answered: number | null }
// The latest round heard for a host, whether it still counts, and the round asked to confirm it.
type HostRound = { round: number; open: boolean; confirming: number | null }

// Stages waiting for their host's pages to stop reading the active build, which commit deletes first.
export type DeferredCommits = {
  // Release when the page stops reading; its swap reopens it so the waiting stage can commit.
  hold(hostKey: string, reader: GenerationReader): GenerationHold
  // Returns a waiting stage this one replaced in another directory, for the caller to delete.
  defer(staged: StagedGeneration): StagedGeneration | null
  // Commits the waiting stage when no page reads this host's build. A stage that fails is discarded and refused:
  // restaging the same build would fail again and reload every page on each resume.
  commitUnread(
    hostKey: string,
    commit: (staged: StagedGeneration) => Promise<unknown>,
    discard: (failed: StagedGeneration) => Promise<void>
  ): Promise<void>
  // A release once this page may fetch the build, or null when it already waits; a page fetching it first is waited out, so it downloads once.
  claim(hostKey: string, buildId: string): Promise<(() => void) | null>
  // Forgets the stage waiting for this host, and returns it.
  drop(hostKey: string): StagedGeneration | null
}

export function createDeferredCommits(): DeferredCommits {
  const readers = new Map<string, Set<Reader>>()
  const rounds = new Map<string, HostRound>()
  const refused = new Map<string, string>()
  const waiting = new Map<string, StagedGeneration>()
  const fetching = new Map<string, Promise<void>>()
  const drop = (hostKey: string): StagedGeneration | null => {
    const found = waiting.get(hostKey)
    if (found === undefined) {
      return null
    }
    waiting.delete(hostKey)
    return found
  }
  return {
    hold: (hostKey, given) => {
      const reader: Reader = { ...given, answered: null }
      const held = readers.get(hostKey) ?? new Set<Reader>()
      readers.set(hostKey, held.add(reader))
      // Answers to every round asked so far are void, including ones still on their way.
      const forget = (): void => {
        const closed = Math.max(rounds.get(hostKey)?.round ?? -1, reader.latestRound())
        rounds.set(hostKey, { round: closed, open: false, confirming: null })
        held.forEach((each) => (each.answered = null))
      }
      return {
        release: () => {
          held.delete(reader)
        },
        withdraw: forget,
        answer: (round, safe) => {
          if (!safe) {
            return forget()
          }
          const host = rounds.get(hostKey)
          const stale =
            host !== undefined && (round < host.round || (round === host.round && !host.open))
          if (!held.has(reader) || stale) {
            return
          }
          if (host?.round !== round) {
            held.forEach((each) => (each.answered = null))
            const confirming = host?.confirming === round ? round : null
            rounds.set(hostKey, { round, open: true, confirming })
          }
          reader.answered = round
          // A reload commits nothing while another page still reads the build, so all of them go together or none does.
          if (!waiting.has(hostKey) || ![...held].every((each) => each.answered === round)) {
            return
          }
          const current = rounds.get(hostKey)
          // Covered pages answer late, so ask every page once more right before reloading any.
          if (current !== undefined && current.confirming !== round) {
            current.confirming = reader.askAgain()
            return
          }
          const swapping = [...held]
          forget()
          swapping.forEach((each) => each.swap())
        }
      }
    },
    defer: (staged) => {
      const { hostKey } = staged
      const replaced = drop(hostKey)
      waiting.set(hostKey, staged)
      const held = readers.get(hostKey)
      const current = rounds.get(hostKey)
      const [first] = held ?? []
      // Pages may answer a resume round before the background fetch finishes staging.
      if (
        first !== undefined &&
        held !== undefined &&
        current?.open === true &&
        current.confirming !== current.round &&
        [...held].every((each) => each.answered === current.round)
      ) {
        current.confirming = first.askAgain()
      }
      return replaced?.directory === staged.directory ? null : replaced
    },
    claim: async (hostKey, buildId) => {
      if (refused.get(hostKey) === buildId) {
        return null
      }
      refused.delete(hostKey)
      const key = `${hostKey}/${buildId}`
      // The page fetching it may leave or fail before it stages, so check again once it settles.
      for (let first = fetching.get(key); first !== undefined; first = fetching.get(key)) {
        await first
      }
      if (waiting.get(hostKey)?.buildId === buildId) {
        return null
      }
      let settle = (): void => {}
      fetching.set(key, new Promise<void>((resolve) => (settle = resolve)))
      return () => {
        fetching.delete(key)
        settle()
      }
    },
    commitUnread: async (hostKey, commit, discard) => {
      const staged = (readers.get(hostKey)?.size ?? 0) > 0 ? null : drop(hostKey)
      if (staged !== null) {
        await commit(staged).catch(() => {
          refused.set(hostKey, staged.buildId)
          return discard(staged)
        })
      }
    },
    drop
  }
}

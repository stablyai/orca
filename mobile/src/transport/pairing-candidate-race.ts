import { hostAnsweredStatusProbe, hostStatusProbe } from './host-status-probe-operations'
import type { PairingCandidateClient } from './mobile-relay-physical-client'

export type PairingCandidatePath = 'direct' | 'relay' | 'iroh'

export type PairingCandidate = {
  path: PairingCandidatePath
  client: PairingCandidateClient
}

export function racePairingCandidates(
  candidates: readonly PairingCandidate[]
): Promise<PairingCandidate> {
  return new Promise((resolve, reject) => {
    const successes: PairingCandidate[] = []
    let failures = 0
    let settled = false
    let selectionQueued = false
    for (const candidate of candidates) {
      void hostStatusProbe.request(candidate.client).then(
        (reply) => {
          if (!hostAnsweredStatusProbe(reply)) {
            failures++
            rejectIfFinished()
            return
          }
          successes.push(candidate)
          if (selectionQueued) {
            return
          }
          selectionQueued = true
          // Why: defer one microtask so simultaneous successes are visible and
          // direct deterministically wins the exact tie regardless of callback order.
          queueMicrotask(() => {
            if (settled) {
              return
            }
            settled = true
            const winner = successes.find(({ path }) => path === 'direct') ?? successes[0]!
            for (const loser of candidates) {
              if (loser !== winner) {
                loser.client.close()
              }
            }
            resolve(winner)
          })
        },
        () => {
          failures++
          rejectIfFinished()
        }
      )
    }

    function rejectIfFinished(): void {
      if (!settled && failures === candidates.length && successes.length === 0) {
        settled = true
        // Why: iroh hosts race alone; the direct/relay wording is pinned by frozen recordings.
        const irohOnly = candidates.every((candidate) => candidate.path === 'iroh')
        reject(
          new Error(
            irohOnly ? 'iroh pairing path failed' : 'direct and relay pairing paths both failed'
          )
        )
      }
    }
  })
}

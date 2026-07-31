import type { PairingCandidateClient } from './mobile-relay-physical-client'

export type PairingCandidate = {
  path: 'direct' | 'relay'
  client: PairingCandidateClient
  url?: string
}

/** Preserve the released direct/Relay pairing strategy for offers without routeOrder. */
export function racePairingCandidates(
  candidates: readonly PairingCandidate[]
): Promise<PairingCandidate> {
  return new Promise((resolve, reject) => {
    const successes: PairingCandidate[] = []
    let failures = 0
    let settled = false
    let selectionQueued = false
    for (const candidate of candidates) {
      void candidate.client.sendRequest('status.get').then(
        (response) => {
          if (!response.ok) {
            failures++
            rejectIfFinished()
            return
          }
          successes.push(candidate)
          if (selectionQueued) {
            return
          }
          selectionQueued = true
          // Why: direct deterministically wins an exact tie, matching the released app.
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
        reject(new Error('direct and relay pairing paths both failed'))
      }
    }
  })
}

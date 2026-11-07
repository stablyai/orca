import {
  hostAnsweredStatusProbe,
  hostStatusProbe,
  readPairingCandidateStatus
} from './host-status-probe-operations'
import type { PairingCandidateClient } from './mobile-relay-physical-client'
import type { HostStatusReply } from './host-status-reply-schema'
import { MobileE2EEAuthenticationError } from './mobile-e2ee-v2-physical-channel'
import { AUTH_REJECTED } from './rpc-client-authentication-retry'
import type { RpcResponse } from './types'

/** The desktop refused the scanned code: it expired or a newer code replaced it. */
export class PairingCodeRejectedError extends Error {
  constructor() {
    super('desktop rejected the pairing code')
  }
}

// Relay and direct report a refused credential differently; old desktops use the same signals.
function isRefusedError(error: unknown): boolean {
  return (
    error instanceof MobileE2EEAuthenticationError ||
    (error instanceof Error && error.message === AUTH_REJECTED)
  )
}

function isRefusedReply(reply: RpcResponse): boolean {
  return !reply.ok && reply.error.code === 'unauthorized'
}

export type PairingCandidatePath = 'direct' | 'relay' | 'iroh'

export type PairingCandidate = {
  path: PairingCandidatePath
  client: PairingCandidateClient
}

export type PairingCandidateWinner = PairingCandidate & {
  status: HostStatusReply | null
}

/**
 * Selects a non-refused status reply, preferring direct among replies received before queued selection.
 * Closes losing clients after success and rejects when every candidate fails.
 */
export function racePairingCandidates(
  candidates: readonly PairingCandidate[]
): Promise<PairingCandidateWinner> {
  return new Promise((resolve, reject) => {
    const successes: PairingCandidateWinner[] = []
    let failures = 0
    let codeRejected = false
    let settled = false
    let selectionQueued = false
    for (const candidate of candidates) {
      void hostStatusProbe.request(candidate.client).then(
        (reply) => {
          if (!hostAnsweredStatusProbe(reply)) {
            failures++
            codeRejected ||= isRefusedReply(reply)
            rejectIfFinished()
            return
          }
          successes.push({ ...candidate, status: readPairingCandidateStatus(reply) })
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
              if (loser.client !== winner.client) {
                loser.client.close()
              }
            }
            resolve(winner)
          })
        },
        (error: unknown) => {
          failures++
          codeRejected ||= isRefusedError(error)
          rejectIfFinished()
        }
      )
    }

    function rejectIfFinished(): void {
      if (!settled && failures === candidates.length && successes.length === 0) {
        settled = true
        const irohOnly = candidates.every((candidate) => candidate.path === 'iroh')
        reject(
          codeRejected
            ? new PairingCodeRejectedError()
            : new Error(
                irohOnly ? 'iroh pairing path failed' : 'direct and relay pairing paths both failed'
              )
        )
      }
    }
  })
}

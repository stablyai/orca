import type { PairingCandidateClient } from './mobile-relay-physical-client'

export type PairingCandidatePath = 'direct' | 'relay'

export type PairingCandidate = {
  path: PairingCandidatePath
  client: PairingCandidateClient
}

export class PairingCandidateRaceError extends Error {
  readonly code: string
  readonly kind: 'transport' | 'response'

  constructor(code: string, message: string, kind: 'transport' | 'response') {
    super(message)
    this.name = 'PairingCandidateRaceError'
    this.code = code
    this.kind = kind
  }
}

export function racePairingCandidates(
  candidates: readonly PairingCandidate[]
): Promise<PairingCandidate> {
  return new Promise((resolve, reject) => {
    const successes: PairingCandidate[] = []
    const failedCandidates: { path: PairingCandidatePath; error: PairingCandidateRaceError }[] = []
    let failureCount = 0
    let settled = false
    let selectionQueued = false
    for (const candidate of candidates) {
      void candidate.client.sendRequest('status.get').then(
        (response) => {
          if (!response.ok) {
            const identity = pairingResponseErrorIdentity(response.error)
            failedCandidates.push({
              path: candidate.path,
              error: new PairingCandidateRaceError(identity.code, identity.message, 'response')
            })
            failureCount++
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
        (error: unknown) => {
          failedCandidates.push({ path: candidate.path, error: pairingCandidateError(error) })
          failureCount++
          rejectIfFinished()
        }
      )
    }

    function rejectIfFinished(): void {
      if (!settled && failureCount === candidates.length && successes.length === 0) {
        settled = true
        const primary =
          failedCandidates.find(({ path }) => path === 'direct')?.error ??
          failedCandidates[0]?.error
        reject(
          primary ??
            new PairingCandidateRaceError(
              'transport_unavailable',
              'pairing paths failed',
              'transport'
            )
        )
      }
    }
  })
}

function pairingResponseErrorIdentity(error: { code: string; message: string }): {
  code: string
  message: string
} {
  if (error.code !== 'runtime_error') {
    return error
  }
  const embeddedCode = error.message.match(/^([A-Za-z][A-Za-z0-9_.-]{1,63}):\s*/)?.[1]
  return { code: embeddedCode ?? error.code, message: error.message }
}

function pairingCandidateError(error: unknown): PairingCandidateRaceError {
  if (
    error instanceof Error &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string'
  ) {
    return new PairingCandidateRaceError(
      (error as { code: string }).code,
      error.message,
      'transport'
    )
  }
  if (error instanceof Error) {
    return new PairingCandidateRaceError(error.name, error.message, 'transport')
  }
  return new PairingCandidateRaceError('transport_unavailable', String(error), 'transport')
}

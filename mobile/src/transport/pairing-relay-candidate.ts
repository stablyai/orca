import type { PairingRelay } from '../../../src/shared/mobile-relay-pairing-offer'
import type { MobileRelayPairingJournal } from './mobile-relay-pairing-journal'
import { RelayOuterError, type PairingCandidateClient } from './mobile-relay-physical-client'

export function createRecoveringPairingRelayCandidate(args: {
  journal: MobileRelayPairingJournal
  connect: (relay: PairingRelay) => PairingCandidateClient
  resolveDirector: (relay: PairingRelay) => Promise<PairingRelay>
  persistMove: (relay: PairingRelay) => Promise<void>
  now: () => number
  random?: () => number
  sleep?: (delayMs: number) => Promise<void>
  maxRecoveryAttempts?: number
}): PairingCandidateClient {
  let relay = pairingRelayFromJournal(args.journal)
  let client = args.connect(relay)
  let closed = false

  return {
    async sendRequest(method, params) {
      try {
        return await client.sendRequest(method, params)
      } catch (error) {
        if (
          method !== 'status.get' ||
          closed ||
          relay.inviteExpiresAt <= args.now() ||
          !isDirectorRecoverable(error)
        ) {
          throw error
        }
        return recoverThroughDirector(method, params, error)
      }
    },
    close() {
      closed = true
      client.close()
    }
  }

  async function recoverThroughDirector(method: string, params: unknown, initialError: unknown) {
    const maxAttempts = args.maxRecoveryAttempts ?? 3
    const random = args.random ?? Math.random
    const sleep =
      args.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)))
    let lastError = initialError
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (closed || relay.inviteExpiresAt <= args.now()) {
        throw lastError
      }
      try {
        const moved = await args.resolveDirector(relay)
        // Why: the authenticated newer assignment must be durable before a
        // target dial so a crash cannot revert to the known-stale cell.
        await args.persistMove(moved)
        client.close()
        relay = moved
        const capMs = Math.min(2_000, 100 * 2 ** attempt)
        await sleep(Math.floor(random() * (capMs + 1)))
        if (closed) {
          throw new Error('relay pairing client closed')
        }
        client = args.connect(relay)
        return await client.sendRequest(method, params)
      } catch (error) {
        lastError = error
        if (!isDirectorRecoverable(error) || attempt + 1 >= maxAttempts) {
          throw error
        }
        const capMs = Math.min(2_000, 100 * 2 ** attempt)
        await sleep(Math.floor(random() * (capMs + 1)))
      }
    }
    throw lastError
  }
}

function pairingRelayFromJournal(journal: MobileRelayPairingJournal): PairingRelay {
  return {
    ...journal.metadata.relay,
    inviteToken: journal.secrets.inviteToken
  }
}

function isDirectorRecoverable(error: unknown): boolean {
  if (!(error instanceof RelayOuterError)) {
    return true
  }
  return error.code === 4409 || error.code === 4503 || error.code === 1006
}

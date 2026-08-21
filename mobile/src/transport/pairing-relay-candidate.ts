import type { PairingRelay } from '../../../src/shared/mobile-relay-pairing-offer'
import type { MobileRelayPairingJournal } from './mobile-relay-pairing-journal'
import { RelayOuterError, type PairingCandidateClient } from './mobile-relay-physical-client'
import { createPairingRelayLogger, pairingRelayErrorDetail } from './pairing-relay-log'
import { redactSocketEndpoint } from './socket-event-debug'
import type { ConnectionLogSink } from './types'

export function createRecoveringPairingRelayCandidate(args: {
  journal: MobileRelayPairingJournal
  connect: (relay: PairingRelay, onLog?: ConnectionLogSink) => PairingCandidateClient
  resolveDirector: (relay: PairingRelay) => Promise<PairingRelay>
  persistMove: (relay: PairingRelay) => Promise<void>
  now: () => number
  random?: () => number
  sleep?: (delayMs: number) => Promise<void>
  maxRecoveryAttempts?: number
  onLog?: ConnectionLogSink
}): PairingCandidateClient {
  const log = createPairingRelayLogger(args.onLog)
  let relay = pairingRelayFromJournal(args.journal)
  let client = args.connect(relay, args.onLog)
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
    const backOff = async (attempt: number): Promise<void> => {
      const capMs = Math.min(2_000, 100 * 2 ** attempt)
      const delayMs = Math.floor(random() * (capMs + 1))
      if (delayMs > 0) {
        log('info', `Relay: backing off ${delayMs}ms`)
      }
      await sleep(delayMs)
    }
    let lastError = initialError
    log('warn', 'Relay: cell dial failed', pairingRelayErrorDetail(initialError))
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (closed || relay.inviteExpiresAt <= args.now()) {
        log('error', 'Relay: recovery gave up', closed ? 'pairing cancelled' : 'invite expired')
        throw lastError
      }
      log(
        'info',
        `Relay: resolving director (attempt ${attempt + 1}/${maxAttempts})`,
        redactSocketEndpoint(relay.directorUrl)
      )
      try {
        const moved = await args.resolveDirector(relay)
        // Why: the authenticated newer assignment must be durable before a
        // target dial so a crash cannot revert to the known-stale cell.
        await args.persistMove(moved)
        log(
          'info',
          'Relay: cell moved',
          `${redactSocketEndpoint(relay.cellUrl)} → ${redactSocketEndpoint(moved.cellUrl)}`
        )
        client.close()
        relay = moved
        await backOff(attempt)
        if (closed) {
          throw new Error('relay pairing client closed')
        }
        client = args.connect(relay, args.onLog)
        return await client.sendRequest(method, params)
      } catch (error) {
        lastError = error
        log('warn', `Relay: recovery attempt ${attempt + 1} failed`, pairingRelayErrorDetail(error))
        if (!isDirectorRecoverable(error) || attempt + 1 >= maxAttempts) {
          log('error', 'Relay: recovery gave up', `after ${attempt + 1} attempt(s)`)
          throw error
        }
        await backOff(attempt)
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

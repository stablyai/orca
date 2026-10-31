import type { PairingRelay } from '../../../src/shared/mobile-relay-pairing-offer'
import { hostStatusProbe } from './host-status-probe-operations'
import type { MobileRelayPairingJournal } from './mobile-relay-pairing-journal'
import { RelayOuterError, type PairingCandidateClient } from './mobile-relay-physical-client'
import { RelayDirectorMoveNotNewerError } from './mobile-relay-invite-director'
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
          method !== hostStatusProbe.operation.method ||
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
    const backOff = async (attempt: number, floorMs = 0): Promise<void> => {
      const capMs = Math.min(2_000, 100 * 2 ** attempt)
      const delayMs = Math.max(floorMs, Math.floor(random() * (capMs + 1)))
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
        // Persist authenticated newer assignments before dialing so a crash cannot revert to the stale cell.
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
        if (error instanceof RelayDirectorMoveNotNewerError) {
          // A non-newer director move confirms the stored assignment; retain it and redial after a real pause.
          log(
            'info',
            directorEchoedCurrentAssignment(error, relay)
              ? 'Relay: director kept current assignment'
              : 'Relay: director has no newer assignment',
            redactSocketEndpoint(relay.cellUrl)
          )
          client.close()
          await backOff(attempt, NOT_NEWER_RETRY_FLOOR_MS)
          if (closed) {
            throw new Error('relay pairing client closed')
          }
          try {
            client = args.connect(relay, args.onLog)
            return await client.sendRequest(method, params)
          } catch (retryError) {
            lastError = retryError
            log(
              'warn',
              `Relay: recovery attempt ${attempt + 1} failed`,
              pairingRelayErrorDetail(retryError)
            )
            if (!isDirectorRecoverable(retryError) || attempt + 1 >= maxAttempts) {
              log('error', 'Relay: recovery gave up', `after ${attempt + 1} attempt(s)`)
              throw retryError
            }
            await backOff(attempt)
            continue
          }
        }
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

// Floor confirmed-assignment retries so near-zero jitter cannot hammer the refusing cell.
const NOT_NEWER_RETRY_FLOOR_MS = 250

function directorEchoedCurrentAssignment(error: unknown, relay: PairingRelay): boolean {
  return (
    error instanceof RelayDirectorMoveNotNewerError &&
    error.assignmentEpoch === relay.assignmentEpoch &&
    error.cellUrl === relay.cellUrl &&
    error.currentAssignmentEpoch === relay.assignmentEpoch &&
    error.currentCellUrl === relay.cellUrl
  )
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
  // Retry only failures before invite reservation (4409/4503) or cell arrival (1006); 4429 consumes attempts and must not redial.
  return error.code === 4409 || error.code === 4503 || error.code === 1006
}

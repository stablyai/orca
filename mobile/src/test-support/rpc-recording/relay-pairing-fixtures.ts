import type { MobileRelayCredentialBundle } from '../../transport/mobile-relay-credential-bundle'
import type { MobileRelayPairingJournal } from '../../transport/mobile-relay-pairing-journal'
import type { MountContext } from './recording-scenario'
import type { operationModuleLoader } from './operation-module-loader'

export const HOST_ID = 'host-1'
const DEVICE_TOKEN = 'device-token-1'
const PUBLIC_KEY_B64 = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8='
const ENDPOINT = 'ws://192.168.1.10:8765'
const RELAY_HOST_ID = 'relay-host-0001x'
const INVITE_TOKEN = 'invite000000000000000000000000000000000001x'
export const PENDING_RESUME_TOKEN = 'pending00000000000000000000000000000000001x'
const CURRENT_RESUME_TOKEN = 'current00000000000000000000000000000000001x'
export const INSTALL_REQ_ID = 'install-fixture-1'
const RESUME_CONFIRM_REQ_ID = 'confirm-fixture-1'
export const JOURNAL_ID = 'pair-fixture-1'
const OFFER_FINGERPRINT = 'fingerprint0000000000000000000000000000001'
const DIRECTOR_URL = 'https://director.example'
const CELL_URL = 'https://cell.example'
const INVITE_LIFETIME_MS = 5 * 60 * 1000

/** The product's own credential hash, loaded from source: a stand-in would record a fiction. */
export function credentialHash(modules: ReturnType<typeof operationModuleLoader>) {
  return modules.load<typeof import('../../transport/mobile-relay-credential-hash')>(
    'mobile/src/transport/mobile-relay-credential-hash.ts'
  ).hashMobileRelayCredential
}

function relayEndpoint() {
  return {
    v: 1 as const,
    directorUrl: DIRECTOR_URL,
    cellUrl: CELL_URL,
    assignmentEpoch: 1,
    relayHostId: RELAY_HOST_ID,
    e2eeFraming: 2 as const
  }
}

export function pairingRelay() {
  return {
    ...relayEndpoint(),
    inviteToken: INVITE_TOKEN,
    inviteExpiresAt: Date.now() + INVITE_LIFETIME_MS
  }
}

export function pairingOffer() {
  return {
    v: 2 as const,
    endpoint: ENDPOINT,
    deviceToken: DEVICE_TOKEN,
    publicKeyB64: PUBLIC_KEY_B64,
    relay: pairingRelay()
  }
}

export function directHost() {
  return {
    id: HOST_ID,
    name: 'Fixture host',
    endpoint: ENDPOINT,
    deviceToken: DEVICE_TOKEN,
    publicKeyB64: PUBLIC_KEY_B64,
    lastConnected: Date.now()
  }
}

export function credentialBundle(hash: (token: string) => string): MobileRelayCredentialBundle {
  return {
    v: 1,
    hostId: HOST_ID,
    deviceToken: DEVICE_TOKEN,
    current: {
      token: CURRENT_RESUME_TOKEN,
      hash: hash(CURRENT_RESUME_TOKEN),
      version: 3,
      expiresAt: Date.now() + 60_000
    }
  }
}

export function pairingJournal(hash: (token: string) => string): MobileRelayPairingJournal {
  return {
    metadata: {
      v: 1,
      journalId: JOURNAL_ID,
      offerFingerprint: OFFER_FINGERPRINT,
      host: {
        id: HOST_ID,
        name: 'Fixture host',
        endpoint: ENDPOINT,
        publicKeyB64: PUBLIC_KEY_B64,
        lastConnected: 0
      },
      relay: { ...relayEndpoint(), inviteExpiresAt: Date.now() + INVITE_LIFETIME_MS },
      installReqId: INSTALL_REQ_ID,
      resumeConfirmReqId: RESUME_CONFIRM_REQ_ID,
      pendingResumeTokenHash: hash(PENDING_RESUME_TOKEN)
    },
    secrets: {
      v: 1,
      journalId: JOURNAL_ID,
      deviceToken: DEVICE_TOKEN,
      inviteToken: INVITE_TOKEN,
      pendingResumeToken: PENDING_RESUME_TOKEN
    }
  }
}

/**
 * A pairing candidate over the scripted transport. Spread rather than a named `sendRequest`: the
 * raw-port ratchet counts the literal, and an adapter faking a candidate is not a new call site.
 */
export function candidateClient(
  client: MountContext['client'],
  effect: MountContext['effect'],
  path: 'direct' | 'relay'
) {
  return { ...client, close: () => effect('candidate-closed', path) }
}

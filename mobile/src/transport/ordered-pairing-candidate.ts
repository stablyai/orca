import type { PairingCandidateClient } from './mobile-relay-physical-client'
import { MobileE2EEAuthenticationError } from './mobile-e2ee-v2-physical-channel'

export type PairingCandidate = {
  path: 'direct' | 'relay'
  client: PairingCandidateClient
  url?: string
}

export type OrderedPairingCandidate = {
  path: 'direct' | 'relay'
  url?: string
  open: () => PairingCandidateClient
}

export class PairingAuthenticationError extends Error {}

export async function selectOrderedPairingCandidate(
  candidates: readonly OrderedPairingCandidate[],
  timeoutMs: number,
  onOpen?: (client: PairingCandidateClient) => void,
  isCancelled?: () => boolean
): Promise<PairingCandidate> {
  for (const candidate of candidates) {
    if (isCancelled?.()) {
      throw new Error('pairing attempt cancelled')
    }
    let client: PairingCandidateClient
    try {
      client = candidate.open()
    } catch {
      if (isCancelled?.()) {
        throw new Error('pairing attempt cancelled')
      }
      continue
    }
    onOpen?.(client)
    try {
      const response = await requestWithTimeout(client, timeoutMs)
      if (response.ok) {
        return { path: candidate.path, client, url: candidate.url }
      }
      if (response.error.code === 'unauthorized') {
        // Why: a decryptable rejection proves the pinned desktop identity, so
        // trying another address cannot make a host-scoped token valid.
        throw new PairingAuthenticationError(response.error.message)
      }
    } catch (error) {
      client.close()
      if (isCancelled?.()) {
        throw new Error('pairing attempt cancelled')
      }
      if (error instanceof MobileE2EEAuthenticationError) {
        // Why: a Relay E2EE rejection authenticates the pinned desktop identity;
        // a lower-ranked network cannot make the host-scoped credential valid.
        throw new PairingAuthenticationError('pinned desktop rejected Relay authentication')
      }
      if (
        error instanceof PairingAuthenticationError ||
        (candidate.path === 'direct' && client.getState?.() === 'auth-failed')
      ) {
        if (!(error instanceof PairingAuthenticationError)) {
          throw new PairingAuthenticationError('pinned desktop rejected authentication')
        }
        throw error
      }
      continue
    }
    client.close()
  }
  throw new Error('all ordered pairing routes failed')
}

async function requestWithTimeout(client: PairingCandidateClient, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      client.sendRequest('status.get'),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('pairing route authentication timed out')),
          timeoutMs
        )
      })
    ])
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

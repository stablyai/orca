import type { DesktopStatus } from '../worktree/host-worktree-rpc-types'
import { normalizeHostAppVersion, recordHostAppVersion } from './host-app-version-store'
import { readHostProtocolVerdict, type CompatVerdict } from './protocol-compat'
import type { StableLogicalRpcClient } from './stable-logical-rpc-client'
import type { RpcResponse } from './types'

export type HostProtocolVerification = {
  generation: number
  verdict: CompatVerdict
  hostCapabilities: string[]
  floatingWorkspaceEnabled: boolean
  desktopAppVersion: string | null
  /** A probe is in flight, or a host that already answered still has retries left. */
  pending: boolean
}

export type HostProtocolVerificationSource = {
  getVerification: () => HostProtocolVerification
  subscribeVerification: (listener: () => void) => () => void
  retryVerification: () => void
}

export type HostProtocolVerifier = HostProtocolVerificationSource & { stop: () => void }

// Covers the connect wait too: without budgetSpansConnect the wait gets its own full
// timeoutMs, so an attempt can run to twice this before the retry backoff even starts.
export const HOST_STATUS_REQUEST_TIMEOUT_MS = 8_000
const STATUS_RETRY_DELAYS = [1_000, 2_000, 4_000]
const EMPTY_HOST_CAPABILITIES: string[] = []
const UNKNOWN_VERDICT: CompatVerdict = { kind: 'unknown' }

type VerifiedRecord = Omit<HostProtocolVerification, 'generation' | 'pending'>

/** What a client that cannot report verification looks like: waiting, forever. */
export const UNVERIFIED_HOST_PROTOCOL: HostProtocolVerification = {
  generation: 0,
  verdict: UNKNOWN_VERDICT,
  hostCapabilities: EMPTY_HOST_CAPABILITIES,
  floatingWorkspaceEnabled: false,
  desktopAppVersion: null,
  pending: true
}

/**
 * Drives the `status.get` that opens a logical client's protocol admission, and holds the
 * verdict the UI reads. This belongs to the client rather than to a route: admission gates
 * every RPC the app makes, while the gate component only ever mounts under `/h/`, so a
 * route-owned probe leaves the launch screen and its notification stream permanently closed.
 */
export function startHostProtocolVerifier(
  client: StableLogicalRpcClient,
  hostId: string | undefined
): HostProtocolVerifier {
  const listeners = new Set<() => void>()
  let generation = client.getGeneration()
  let record: VerifiedRecord | null = null
  let settled = false
  let probing = false
  let everVerified = false
  let attempt = 0
  let needsProbe = true
  let lastState = client.getState()
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  let snapshot = buildSnapshot()

  const unsubscribe = client.onStateChange(handleClientChange)
  pump()

  return {
    getVerification: () => snapshot,
    subscribeVerification(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    retryVerification() {
      restartProbe()
      publish()
      pump()
    },
    stop() {
      stopped = true
      clearRetry()
      unsubscribe()
      listeners.clear()
    }
  }

  function buildSnapshot(): HostProtocolVerification {
    return {
      generation,
      verdict: record?.verdict ?? UNKNOWN_VERDICT,
      hostCapabilities: record?.hostCapabilities ?? EMPTY_HOST_CAPABILITIES,
      floatingWorkspaceEnabled: record?.floatingWorkspaceEnabled ?? false,
      desktopAppVersion: record?.desktopAppVersion ?? null,
      pending: probing || !settled
    }
  }

  function publish(): void {
    const next = buildSnapshot()
    if (
      next.generation === snapshot.generation &&
      next.verdict === snapshot.verdict &&
      next.hostCapabilities === snapshot.hostCapabilities &&
      next.floatingWorkspaceEnabled === snapshot.floatingWorkspaceEnabled &&
      next.desktopAppVersion === snapshot.desktopAppVersion &&
      next.pending === snapshot.pending
    ) {
      return
    }
    snapshot = next
    for (const listener of listeners) {
      listener()
    }
  }

  function handleClientChange(): void {
    if (stopped) {
      return
    }
    const nextGeneration = client.getGeneration()
    const state = client.getState()
    if (nextGeneration !== generation) {
      // A cutover resets admission, so the replacement generation owes a fresh verdict.
      generation = nextGeneration
      record = null
      settled = false
      restartProbe()
    } else if (state === 'connected' && lastState !== 'connected') {
      restartProbe()
    }
    lastState = state
    publish()
    pump()
  }

  function restartProbe(): void {
    attempt = 0
    clearRetry()
    needsProbe = true
  }

  function pump(): void {
    if (stopped || probing || !needsProbe || client.getState() !== 'connected') {
      return
    }
    needsProbe = false
    void probe(generation)
  }

  async function probe(probeGeneration: number): Promise<void> {
    probing = true
    publish()
    const response = await requestStatus()
    probing = false
    if (stopped) {
      return
    }
    // Why: redundant defence — the logical client already rejects a stale-generation reply
    // with LogicalClientCutoverError, and handleClientChange cleared this record anyway.
    if (probeGeneration === generation) {
      apply(response)
    }
    // A cutover during the request queued a replacement probe behind this one.
    pump()
  }

  async function requestStatus(): Promise<RpcResponse | null> {
    try {
      return await client.sendRequest('status.get', undefined, {
        timeoutMs: HOST_STATUS_REQUEST_TIMEOUT_MS,
        budgetSpansConnect: true
      })
    } catch {
      return null
    }
  }

  function apply(response: RpcResponse | null): void {
    const verdict = response?.ok ? readHostProtocolVerdict(response.result) : UNKNOWN_VERDICT
    if (!response?.ok || verdict.kind === 'unknown') {
      settleUnverified()
      return
    }
    const status = response.result as DesktopStatus & { capabilities?: string[] }
    const desktopAppVersion = normalizeHostAppVersion(status.appVersion)
    if (hostId && desktopAppVersion) {
      void recordHostAppVersion(hostId, desktopAppVersion)
    }
    record = {
      verdict,
      hostCapabilities: status.capabilities ?? EMPTY_HOST_CAPABILITIES,
      floatingWorkspaceEnabled: status.floatingWorkspaceEnabled === true,
      desktopAppVersion
    }
    settled = true
    everVerified = true
    attempt = 0
    clearRetry()
    publish()
    if (verdict.kind === 'blocked') {
      console.warn('[protocol-compat] blocked', {
        reason: verdict.reason,
        desktopVersion: verdict.desktopVersion,
        requiredMobileVersion: verdict.requiredMobileVersion,
        requiredDesktopVersion: verdict.requiredDesktopVersion
      })
    }
  }

  function settleUnverified(): void {
    const delay = STATUS_RETRY_DELAYS[attempt++]
    // Why: a host that already answered once keeps waiting through its bounded retries, so a
    // single post-cutover hiccup does not bury a live screen under an unrecoverable card. A
    // host that never answered, or one out of retries, settles now and offers Retry.
    settled = record !== null || !everVerified || delay === undefined
    publish()
    if (delay !== undefined) {
      retryTimer = setTimeout(() => {
        retryTimer = null
        needsProbe = true
        pump()
      }, delay)
    }
  }

  function clearRetry(): void {
    if (retryTimer !== null) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
  }
}

/** Gives a logical client its own verification, and stops the probe when the client closes. */
export function attachHostProtocolVerification<T extends StableLogicalRpcClient>(
  client: T,
  hostId: string | undefined
): T & HostProtocolVerificationSource {
  const verifier = startHostProtocolVerifier(client, hostId)
  const closeClient = client.close
  return Object.assign(client, {
    getVerification: verifier.getVerification,
    subscribeVerification: verifier.subscribeVerification,
    retryVerification: verifier.retryVerification,
    close: () => {
      verifier.stop()
      closeClient()
    }
  })
}

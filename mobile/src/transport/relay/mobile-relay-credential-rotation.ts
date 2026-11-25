import * as ExpoCrypto from 'expo-crypto'
import type {
  DeviceResumeConfirmed,
  MobileRelayEndpoint
} from '../../../../src/shared/remote-runtime/relay/mobile-relay-credential-contract'
import {
  MobileRelayCredentialBundleSchema,
  type MobileRelayCredentialBundle
} from '../../host-credentials/mobile-relay-credential-bundle'
import { hashMobileRelayCredential } from './mobile-relay-credential-hash'
import {
  relayCredentialProvision,
  relayPairingEndpointsRead
} from '../../pairing/mobile-relay-pairing-operations'
import type { RpcClient } from '../rpc/rpc-client-contract'

const CREDENTIAL_ROTATION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

type RotationResult = {
  bundle: MobileRelayCredentialBundle
  relay: MobileRelayEndpoint
}

export async function rotateMobileRelayCredential(args: {
  client: RpcClient
  bundle: MobileRelayCredentialBundle
  writeBundle: (bundle: MobileRelayCredentialBundle) => Promise<void>
  randomBytes?: (length: number) => Uint8Array
}): Promise<RotationResult> {
  let bundle = args.bundle
  if (!bundle.pending) {
    const randomBytes = args.randomBytes ?? ExpoCrypto.getRandomBytes
    const token = encodeBase64Url(randomBytes(32))
    bundle = MobileRelayCredentialBundleSchema.parse({
      ...bundle,
      pending: {
        token,
        hash: hashMobileRelayCredential(token),
        reqId: `rotate-${encodeBase64Url(randomBytes(16))}`
      }
    })
    // Persist enough install material to query the same global key after a crash/lost reply before authorizing another.
    await args.writeBundle(bundle)
  }

  const pending = bundle.pending
  if (!pending) {
    throw new Error('relay credential rotation pending state missing')
  }
  let endpoints = await getEndpoints(args.client, pending.reqId)
  if (endpoints.installStatus?.state !== 'committed') {
    const installReply = await relayCredentialProvision.request(args.client, {
      reqId: pending.reqId,
      newResumeTokenHash: pending.hash,
      expectedCurrentHash: bundle.current.hash
    })
    const installed = relayCredentialProvision.interpret(installReply)
    endpoints = await getEndpoints(args.client, pending.reqId)
    if (
      endpoints.installStatus?.state !== 'committed' ||
      JSON.stringify(endpoints.installStatus.result) !== JSON.stringify(installed)
    ) {
      throw new Error('relay credential rotation was not authoritatively committed')
    }
  }
  if (!endpoints.relay || endpoints.installStatus?.state !== 'committed') {
    throw new Error('relay credential rotation endpoint state missing')
  }
  const installed = endpoints.installStatus.result
  const next = MobileRelayCredentialBundleSchema.parse({
    ...bundle,
    current: {
      token: pending.token,
      hash: pending.hash,
      version: installed.currentVersion,
      expiresAt: installed.resumeExpiresAt
    },
    ...(installed.graceExpiresAt
      ? { grace: { ...bundle.current, expiresAt: installed.graceExpiresAt } }
      : { grace: undefined }),
    pending: undefined
  })
  await args.writeBundle(next)
  return { bundle: next, relay: endpoints.relay }
}

export function mobileRelayCredentialNeedsRotation(
  bundle: MobileRelayCredentialBundle,
  now: number
): boolean {
  // Repair pre-release decoded-byte hashes over authenticated direct connectivity using the stored hash.
  const malformedCurrentHash =
    bundle.current.hash !== hashMobileRelayCredential(bundle.current.token)
  return (
    Boolean(bundle.pending) ||
    malformedCurrentHash ||
    bundle.current.expiresAt - now <= CREDENTIAL_ROTATION_WINDOW_MS
  )
}

// A committed install can only follow `expectedCurrentHash`, so the relay numbered it current + 1.
// The relay alone knows its expiry; the lease stays dialable until the relay answers.
export function pendingRelayCredentialLease(
  bundle: MobileRelayCredentialBundle
): MobileRelayCredentialBundle['current'] | null {
  if (!bundle.pending) {
    return null
  }
  return {
    token: bundle.pending.token,
    hash: bundle.pending.hash,
    version: bundle.current.version + 1,
    expiresAt: Number.MAX_SAFE_INTEGER
  }
}

// Dial order: the pending install is tried only after the relay refuses current and grace.
export function relayDialCandidates(
  bundle: MobileRelayCredentialBundle
): (MobileRelayCredentialBundle['current'] | null | undefined)[] {
  return [bundle.current, bundle.grace, pendingRelayCredentialLease(bundle)]
}

export function applyResumeConfirmation(
  bundle: MobileRelayCredentialBundle,
  usedCredentialVersion: number,
  confirmation: DeviceResumeConfirmed
): MobileRelayCredentialBundle {
  const pending = pendingRelayCredentialLease(bundle)
  const usedPendingOrCurrent =
    confirmation.acceptedAs === 'current'
      ? usedCredentialVersion === pending?.version
      : usedCredentialVersion === bundle.current.version
  if (pending && confirmation.currentVersion === pending.version && usedPendingOrCurrent) {
    // The relay names pending's version as current, so a rotation committed but its reply was lost.
    // Adopt it as direct reconciliation would; resumeExpiresAt is always the relay's current expiry.
    return MobileRelayCredentialBundleSchema.parse({
      ...bundle,
      current: {
        token: pending.token,
        hash: pending.hash,
        version: pending.version,
        expiresAt: confirmation.resumeExpiresAt
      },
      grace: confirmation.graceExpiresAt
        ? { ...bundle.current, expiresAt: confirmation.graceExpiresAt }
        : undefined,
      pending: undefined
    })
  }
  if (
    confirmation.acceptedAs === 'current' &&
    confirmation.renewed &&
    bundle.current.version === usedCredentialVersion &&
    confirmation.currentVersion === usedCredentialVersion
  ) {
    return MobileRelayCredentialBundleSchema.parse({
      ...bundle,
      current: { ...bundle.current, expiresAt: confirmation.resumeExpiresAt }
    })
  }
  if (
    confirmation.acceptedAs === 'grace' &&
    bundle.grace?.version === usedCredentialVersion &&
    confirmation.graceExpiresAt
  ) {
    return MobileRelayCredentialBundleSchema.parse({
      ...bundle,
      grace: { ...bundle.grace, expiresAt: confirmation.graceExpiresAt }
    })
  }
  return bundle
}

// Rotate against resume expiry, not the hello’s short attach-reservation deadline.
// Skip unrenewed confirmations: repeating the same expiry would churn replacements at every clamp floor.
export async function persistResumeConfirmation(args: {
  session: {
    getResumeConfirmation(): DeviceResumeConfirmed | null
    getResumeExpiresAt(): number | null
  }
  bundle: MobileRelayCredentialBundle
  usedCredentialVersion: number
  writeBundle: (bundle: MobileRelayCredentialBundle) => Promise<void>
}): Promise<{ bundle: MobileRelayCredentialBundle; leaseExpiry: number | null }> {
  const confirmation = args.session.getResumeConfirmation()
  let bundle = args.bundle
  if (confirmation) {
    bundle = applyResumeConfirmation(bundle, args.usedCredentialVersion, confirmation)
    // Persistence failure after relay authentication must not trigger another dial or transport cooldown.
    await args.writeBundle(bundle).catch(() => {})
  }
  const leaseExpiry =
    confirmation?.renewed === false
      ? null
      : (confirmation?.resumeExpiresAt ?? args.session.getResumeExpiresAt())
  return { bundle, leaseExpiry }
}

async function getEndpoints(client: RpcClient, installReqId: string) {
  const reply = await relayPairingEndpointsRead.request(client, { installReqId })
  return relayPairingEndpointsRead.interpret(reply)
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = ''
  for (const byte of value) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

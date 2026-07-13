import * as ExpoCrypto from 'expo-crypto'
import { sha256 } from '@noble/hashes/sha256'
import {
  DeviceCredentialInstalledSchema,
  PairingGetEndpointsResultSchema,
  type DeviceResumeConfirmed,
  type MobileRelayEndpoint
} from '../../../src/shared/mobile-relay-credential-contract'
import {
  MobileRelayCredentialBundleSchema,
  type MobileRelayCredentialBundle
} from './mobile-relay-credential-bundle'
import type { RpcClient } from './rpc-client'

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
        hash: encodeBase64Url(sha256(decodeBase64Url(token))),
        reqId: `rotate-${encodeBase64Url(randomBytes(16))}`
      }
    })
    // Why: a crash or lost response must leave enough material to query the
    // one global install key before any second authorization attempt.
    await args.writeBundle(bundle)
  }

  const pending = bundle.pending
  if (!pending) {
    throw new Error('relay credential rotation pending state missing')
  }
  let endpoints = await getEndpoints(args.client, pending.reqId)
  if (endpoints.installStatus?.state !== 'committed') {
    const response = await args.client.sendRequest('pairing.provisionRelay', {
      reqId: pending.reqId,
      newResumeTokenHash: pending.hash,
      expectedCurrentHash: bundle.current.hash
    })
    if (!response.ok) {
      throw new Error(`${response.error.code}: ${response.error.message}`)
    }
    const installed = DeviceCredentialInstalledSchema.parse(response.result)
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

export function applyResumeConfirmation(
  bundle: MobileRelayCredentialBundle,
  usedCredentialVersion: number,
  confirmation: DeviceResumeConfirmed
): MobileRelayCredentialBundle {
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

async function getEndpoints(client: RpcClient, installReqId: string) {
  const response = await client.sendRequest('pairing.getEndpoints', { installReqId })
  if (!response.ok) {
    throw new Error(`${response.error.code}: ${response.error.message}`)
  }
  return PairingGetEndpointsResultSchema.parse(response.result)
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = ''
  for (const byte of value) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function decodeBase64Url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = `${base64}${'='.repeat((4 - (base64.length % 4)) % 4)}`
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0))
}

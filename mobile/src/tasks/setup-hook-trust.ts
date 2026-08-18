import type { PersistedTrustedOrcaHooks } from '../../../src/shared/orca-yaml-hook-types'
import { sha256 } from '@noble/hashes/sha256'
import {
  parseSetupHookTrust,
  setupHookApprovalFromTrust,
  type SetupHookApproval,
  type SetupHookTrust
} from '../../../src/shared/setup-hook-approval'
import type { RpcClient } from '../transport/rpc-client'
export type { SetupHookApproval, SetupHookTrust }

export function isSetupHookTrusted(
  trust: PersistedTrustedOrcaHooks,
  repoId: string,
  contentHash: string
): boolean {
  const repoTrust = trust[repoId]
  return Boolean(repoTrust?.all || repoTrust?.setup?.contentHash === contentHash)
}

export function wasSetupHookPreviouslyApproved(
  trust: PersistedTrustedOrcaHooks,
  repoId: string
): boolean {
  return Boolean(trust[repoId]?.setup?.contentHash)
}

export function trustedOrcaHooksWithSetupApproval(args: {
  trust: PersistedTrustedOrcaHooks
  repoId: string
  contentHash: string
  alwaysTrust: boolean
  approvedAt?: number
}): PersistedTrustedOrcaHooks {
  const approvedAt = args.approvedAt ?? Date.now()
  const existing = args.trust[args.repoId]
  const nextRepo = args.alwaysTrust
    ? { ...existing, all: { approvedAt } }
    : { ...existing, setup: { contentHash: args.contentHash, approvedAt } }
  return { ...args.trust, [args.repoId]: nextRepo }
}

export async function persistSetupHookTrustApproval(args: {
  client: RpcClient
  trust: PersistedTrustedOrcaHooks
  repoId: string
  contentHash: string
  alwaysTrust: boolean
}): Promise<PersistedTrustedOrcaHooks> {
  const next = trustedOrcaHooksWithSetupApproval(args)
  const response = await args.client.sendRequest('ui.set', { trustedOrcaHooks: next })
  if (!response.ok) {
    throw new Error(response.error.message)
  }
  return next
}

export function normalizeSetupHookTrust(
  setupTrust: SetupHookTrust | null | undefined
): SetupHookTrust | null {
  const parsed = parseSetupHookTrust(setupTrust)
  if (!parsed || hashSetupHookTrustContent(parsed.scriptContent) !== parsed.contentHash) {
    return null
  }
  return parsed
}

export { setupHookApprovalFromTrust }

export function hashSetupHookTrustContent(content: string): string {
  const bytes = new TextEncoder().encode(content.trim())
  return Array.from(sha256(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

import type { PersistedTrustedOrcaHooks } from '../../../src/shared/types'

export type SetupHookTrust = {
  contentHash: string
  scriptContent: string
}

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

export function normalizeSetupHookTrust(
  setupTrust: SetupHookTrust | null | undefined
): SetupHookTrust | null {
  if (!setupTrust?.contentHash || !setupTrust.scriptContent) {
    return null
  }
  return setupTrust
}

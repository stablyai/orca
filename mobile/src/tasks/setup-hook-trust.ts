import type { PersistedTrustedOrcaHooks } from '../../../src/shared/orca-yaml-hook-types'
import {
  canUseRepoWideTrust,
  type OrcaHookTrustKind,
  withOrcaHookRepoAlwaysTrusted,
  withOrcaHookScriptConfirmed
} from '../../../src/shared/orca-hook-trust-entries'
import type { RpcClient } from '../transport/rpc-client'
import { taskUiStateWrite } from './mobile-task-runtime-operations'

export type SetupHookTrust = {
  contentHash: string
  scriptContent: string
}

export function isOrcaHookTrusted(
  trust: PersistedTrustedOrcaHooks,
  repos: readonly { id: string }[],
  repoId: string,
  kind: OrcaHookTrustKind,
  contentHash: string
): boolean {
  return (
    canUseRepoWideTrust(trust, repos, repoId) || trust[repoId]?.[kind]?.contentHash === contentHash
  )
}

export function isSetupHookTrusted(
  trust: PersistedTrustedOrcaHooks,
  repos: readonly { id: string }[],
  repoId: string,
  contentHash: string
): boolean {
  return isOrcaHookTrusted(trust, repos, repoId, 'setup', contentHash)
}

export function wasOrcaHookPreviouslyApproved(
  trust: PersistedTrustedOrcaHooks,
  repoId: string,
  kind: OrcaHookTrustKind
): boolean {
  return Boolean(trust[repoId]?.[kind]?.contentHash)
}

export function wasSetupHookPreviouslyApproved(
  trust: PersistedTrustedOrcaHooks,
  repoId: string
): boolean {
  return wasOrcaHookPreviouslyApproved(trust, repoId, 'setup')
}

type HookTrustApproval = {
  client: RpcClient
  trust: PersistedTrustedOrcaHooks
  repoId: string
  contentHash: string
  alwaysTrust: boolean
}

export async function persistOrcaHookTrustApproval(
  args: HookTrustApproval & { kind: OrcaHookTrustKind }
): Promise<PersistedTrustedOrcaHooks> {
  const next = args.alwaysTrust
    ? withOrcaHookRepoAlwaysTrusted(args.trust, args.repoId)
    : withOrcaHookScriptConfirmed(args.trust, args.repoId, args.kind, args.contentHash)
  taskUiStateWrite.interpret(
    await taskUiStateWrite.request(args.client, { trustedOrcaHooks: next })
  )
  return next
}

export function persistSetupHookTrustApproval(
  args: HookTrustApproval
): Promise<PersistedTrustedOrcaHooks> {
  return persistOrcaHookTrustApproval({ ...args, kind: 'setup' })
}

// Hooks may omit setupTrust; validate the pair here while preserving other host fields.
export function normalizeSetupHookTrust(
  setupTrust: { contentHash?: string; scriptContent?: string } | null | undefined
): SetupHookTrust | null {
  const contentHash = setupTrust?.contentHash
  const scriptContent = setupTrust?.scriptContent
  if (!contentHash || !scriptContent) {
    return null
  }
  return { ...setupTrust, contentHash, scriptContent }
}

// New hosts send setupConfig (orca.yaml setup plus defaultTabs commands); older ones only the effective setup script.
export function readRepoHooksSetupCommand(reply: {
  hooks?: { scripts?: { setup?: string } } | null
  setupConfig?: { command: string } | null
}): string | null {
  if (reply.setupConfig !== undefined) {
    return reply.setupConfig?.command.trim() || null
  }
  return reply.hooks?.scripts?.setup?.trim() || null
}

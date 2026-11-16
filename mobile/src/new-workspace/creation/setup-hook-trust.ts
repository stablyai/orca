import type { PersistedTrustedOrcaHooks } from '../../../../src/shared/workspace-setup/orca-yaml-hook-types'
import {
  isOrcaHookContentApproved,
  isOrcaHookRepoIdOnSeveralHosts,
  isOrcaHookRepoTrusted,
  type OrcaHookTrustKind,
  withOrcaHookRepoAlwaysTrusted,
  withOrcaHookScriptConfirmed
} from '../../../../src/shared/workspace-setup/hooks/orca-hook-trust-entries'
import type { SetupHooksCreateSource } from '../../../../src/shared/worktree/setup-hooks-create-source'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { OrcaHookTrustPrompt } from '../../components/hook-trust/OrcaHookTrustDrawer'
import { taskUiStateWrite } from '../../tasks/screen-state/mobile-task-runtime-operations'
import { repoSetupHooksRead } from './mobile-workspace-source-operations'

export type SetupHookTrust = {
  contentHash: string
  scriptContent: string
}

/** Same-id repos on several hosts keep per-version approvals; an unknown repo list can't rule that out. */
export function usesVersionedOrcaHookTrust(
  repos: readonly { id: string }[] | null,
  repoId: string
): boolean {
  return !repos || isOrcaHookRepoIdOnSeveralHosts(repos, repoId)
}

export function isOrcaHookTrusted(
  trust: PersistedTrustedOrcaHooks,
  repos: readonly { id: string }[] | null,
  repoId: string,
  kind: OrcaHookTrustKind,
  contentHash: string
): boolean {
  return (
    (repos !== null && isOrcaHookRepoTrusted(trust, repos, repoId)) ||
    isOrcaHookContentApproved(trust, repoId, kind, contentHash)
  )
}

export function wasOrcaHookPreviouslyApproved(
  trust: PersistedTrustedOrcaHooks,
  repoId: string,
  kind: OrcaHookTrustKind
): boolean {
  return Boolean(trust[repoId]?.[kind]?.contentHash)
}

/** What a create sends once its setup is approved: a hash pins the run to the shown content. */
export type CreateSetupApproval = { approvedSetupHash?: string }

/** Approves a create's setup without asking, or returns a prompt with the setup of the ref it checks out. */
export async function resolveCreateSetupApproval(args: {
  client: RpcClient
  trust: PersistedTrustedOrcaHooks
  repos: readonly { id: string }[]
  repo: { id: string; displayName: string }
  createSource: SetupHooksCreateSource
}): Promise<{ approved: CreateSetupApproval } | { ask: OrcaHookTrustPrompt }> {
  const repoId = args.repo.id
  if (isOrcaHookRepoTrusted(args.trust, args.repos, repoId)) {
    return { approved: {} }
  }
  // Older hosts ignore createSource and report the project checkout's setup.
  const reply = repoSetupHooksRead.interpret(
    await repoSetupHooksRead.request(args.client, {
      repo: `id:${repoId}`,
      createSource: args.createSource
    })
  )
  const setupTrust = normalizeSetupHookTrust(reply.setupTrust)
  if (!setupTrust) {
    return { approved: {} }
  }
  const pinnable = reply.createSourceRead === true
  if (isOrcaHookContentApproved(args.trust, repoId, 'setup', setupTrust.contentHash)) {
    return { approved: pinnable ? { approvedSetupHash: setupTrust.contentHash } : {} }
  }
  return {
    ask: {
      kind: 'setup',
      repoId,
      repoName: args.repo.displayName,
      scriptContent: setupTrust.scriptContent,
      contentHash: setupTrust.contentHash,
      previouslyApproved: wasOrcaHookPreviouslyApproved(args.trust, repoId, 'setup'),
      versionOnly: usesVersionedOrcaHookTrust(args.repos, repoId),
      ...(pinnable ? { pinnable } : {})
    }
  }
}

/** Repo trust runs any content; otherwise the host runs only the approved content when the hash came from the created branch. */
export function approvedCreateSetup(
  repos: readonly { id: string }[] | null,
  prompt: Pick<OrcaHookTrustPrompt, 'repoId' | 'contentHash' | 'pinnable'>,
  alwaysTrust: boolean
): CreateSetupApproval {
  // Without a branch read, a hash could make the host skip setup silently; send none, as before.
  return !prompt.pinnable || (alwaysTrust && !usesVersionedOrcaHookTrust(repos, prompt.repoId))
    ? {}
    : { approvedSetupHash: prompt.contentHash }
}

type HookTrustApproval = {
  client: RpcClient
  trust: PersistedTrustedOrcaHooks
  repos: readonly { id: string }[] | null
  repoId: string
  contentHash: string
  alwaysTrust: boolean
}

/** Run once stores nothing and Always trust stores repo trust; same-id repos also keep this version. */
export async function persistOrcaHookTrustApproval(
  args: HookTrustApproval & { kind: OrcaHookTrustKind }
): Promise<PersistedTrustedOrcaHooks> {
  const confirmed = usesVersionedOrcaHookTrust(args.repos, args.repoId)
    ? withOrcaHookScriptConfirmed(args.trust, args.repoId, args.kind, args.contentHash)
    : args.trust
  const next = args.alwaysTrust ? withOrcaHookRepoAlwaysTrusted(confirmed, args.repoId) : confirmed
  if (next !== args.trust) {
    taskUiStateWrite.interpret(
      await taskUiStateWrite.request(args.client, { trustedOrcaHooks: next })
    )
  }
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

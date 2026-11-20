import { z } from 'zod'
import { getPresentStringFlag } from '../arguments/flags'
import { RuntimeClientError } from '../runtime/connection/types'
import type { RuntimeClient } from '../runtime/client'
import { isOrcaHookTrusted } from '../../shared/workspace-setup/hooks/orca-hook-trust-entries'
import type { PersistedTrustedOrcaHooks } from '../../shared/workspace-setup/orca-yaml-hook-types'

export type ArchiveHookChoice = 'run' | 'skip' | 'inherit'

/** Reported on `result.archiveHook`; `run` asks the host to run whatever archive script the repo has. */
export type ArchiveHookDecision =
  | { decision: 'run'; reason: 'requested' | 'approved' }
  | { decision: 'skip'; reason: 'requested' | 'none' | 'not-approved' | 'unverifiable' }

export function getArchiveHookChoice(flags: Map<string, string | boolean>): ArchiveHookChoice {
  const archive = getPresentStringFlag(flags, 'archive')
  if (archive !== undefined && archive !== 'run' && archive !== 'skip' && archive !== 'inherit') {
    throw new RuntimeClientError('invalid_argument', '--archive must be one of: run, skip, inherit')
  }
  const runHooks = flags.get('run-hooks') === true
  if (runHooks && archive !== undefined && archive !== 'run') {
    throw new RuntimeClientError(
      'invalid_argument',
      'Choose either --run-hooks or --archive skip|inherit, not both.'
    )
  }
  const choice = runHooks ? 'run' : (archive ?? 'inherit')
  if (choice === 'skip' && flags.get('allow-failed-archive-hook') === true) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--allow-failed-archive-hook waives a FAILED archive hook, but --archive skip runs no hook. Drop one of them.'
    )
  }
  return choice
}

// archiveTrust: null means no orca.yaml archive script needs approval; absent (older host, SSH project) means unknown.
const RepoArchiveHook = z.looseObject({
  hooks: z
    .looseObject({ scripts: z.looseObject({ archive: z.string().optional() }).optional() })
    .nullable()
    .optional(),
  archiveTrust: z
    .looseObject({ contentHash: z.string().min(1) })
    .nullable()
    .optional()
})
const UiTrust = z.looseObject({
  ui: z.looseObject({ trustedOrcaHooks: z.record(z.string(), z.unknown()).optional() })
})
const RepoIds = z.looseObject({ repos: z.array(z.looseObject({ id: z.string() })) })

/** Inherit runs the archive hook exactly when the desktop's Delete would run it without asking. */
export async function resolveArchiveHookDecision(
  client: RuntimeClient,
  choice: ArchiveHookChoice,
  repoId: string
): Promise<ArchiveHookDecision> {
  if (choice !== 'inherit') {
    return { decision: choice, reason: 'requested' }
  }
  try {
    const hooks = RepoArchiveHook.parse(
      (await client.call('repo.hooks', { repo: `id:${repoId}` })).result
    )
    if (hooks.archiveTrust === undefined) {
      return { decision: 'skip', reason: 'unverifiable' }
    }
    if (hooks.archiveTrust === null) {
      return hooks.hooks?.scripts?.archive?.trim()
        ? { decision: 'run', reason: 'approved' }
        : { decision: 'skip', reason: 'none' }
    }
    const [ui, repoList] = await Promise.all([client.call('ui.get'), client.call('repo.list')])
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: trust readers ignore malformed entries.
    const trust = (UiTrust.parse(ui.result).ui.trustedOrcaHooks ?? {}) as PersistedTrustedOrcaHooks
    const repos = RepoIds.parse(repoList.result).repos
    return isOrcaHookTrusted(trust, repos, repoId, 'archive', hooks.archiveTrust.contentHash)
      ? { decision: 'run', reason: 'approved' }
      : { decision: 'skip', reason: 'not-approved' }
  } catch {
    return { decision: 'skip', reason: 'unverifiable' }
  }
}

export function archiveHookSkipWarning(decision: ArchiveHookDecision): string | undefined {
  if (decision.reason === 'not-approved') {
    return "The archive hook did not run: this version of the repository's orca.yaml script hasn't been approved in Orca. Pass --archive run to run it."
  }
  if (decision.reason === 'unverifiable') {
    return "No archive hook ran: Orca couldn't check whether this repository's hook is approved. Pass --archive run to run it."
  }
  return undefined
}

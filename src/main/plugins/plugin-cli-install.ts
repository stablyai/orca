import {
  buildPluginApprovalRequest,
  pluginNeedsCliApproval,
  PluginApprovalRequiredError,
  PluginCliError,
  type PluginApprovalUpdateInfo
} from '../../shared/plugins/approval/plugin-cli-approval'
import type { PluginConsentRequest } from '../../shared/plugins/approval/plugin-consent-request'
import { pluginUpdateGrowsAccess } from '../../shared/plugins/approval/plugin-update-access-growth'
import {
  isSamePluginSource,
  pluginSourceLabel
} from '../../shared/plugins/catalog/plugin-marketplace'
import { parsePluginGitInstallInput } from '../../shared/plugins/installation/plugin-git-install-input'
import type { PluginInstallSourceInfo } from '../../shared/plugins/installation/plugin-install-source-info'
import type { PluginInstallSource } from '../../shared/plugins/installation/plugin-install-lockfile'
import type { RpcCallerIdentity } from '../runtime/rpc/rpc-caller-identity'
import type { PluginPolicySource } from './plugin-activation-policy'
import {
  installCatalogReleaseWithApproval,
  readApprovedPredecessor,
  readPreviewAccessGrowth
} from './catalog/plugin-update-approval'
import { catalogInstallCandidate, type PluginCliCatalogs } from './plugin-cli-catalog-candidates'
import {
  gitInstallCandidate,
  installFailed,
  localInstallCandidate,
  type PluginCliCandidateHost,
  type PluginCliInstallCandidate,
  type PluginInstallLocation
} from './plugin-cli-install-candidates'
import {
  approvePluginFromCli,
  type PluginCliApprovalOutcome,
  type PluginCliApprovalService
} from './plugin-cli-approval'
import { assertPluginSystemEnabled } from './plugin-dev-folders'

export type PluginCliInstallService = PluginCliApprovalService & {
  readonly options: PluginCliApprovalService['options'] &
    PluginPolicySource & { userDataPath: string; hostVersion: string }
  refresh: () => Promise<void>
}

export type PluginCliInstallDeps = {
  service: PluginCliInstallService
  catalogs: PluginCliCatalogs
  applyConsent: (request: PluginConsentRequest) => Promise<void>
  executionHost: string
  caller: RpcCallerIdentity | undefined
}

export type PluginCliInstallSpec =
  | { kind: 'catalog'; pluginKey: string; catalog?: string }
  | { kind: 'git'; input: string }
  | { kind: 'local-path'; path: string }

/** `kept`: an update that asks for nothing new keeps the running version's approval. */
export type PluginCliInstallApproval = PluginCliApprovalOutcome | 'kept' | 'not-approved'

export type PluginCliInstallOutcome = {
  pluginKey: string
  version: string
  previousVersion: string | null
  contentHash: string
  resolvedCommit: string | null
  approval: PluginCliInstallApproval
  source: PluginInstallSourceInfo
}

export function candidateHost(deps: PluginCliInstallDeps): PluginCliCandidateHost {
  const { options } = deps.service
  return {
    userDataPath: options.userDataPath,
    hostVersion: options.hostVersion,
    executionHost: deps.executionHost,
    blockedPluginReason: (pluginKey) => options.getPluginKillListEntry?.(pluginKey)?.reason ?? null
  }
}

const GIT_INPUT_ERRORS: Record<string, string> = {
  'missing-git-url': 'Pass a repository such as owner/repo or a Git URL.',
  'git-url-credentials':
    "Remove the username or token from the URL. Orca uses the Orca host's own Git sign-in (credential helper or SSH agent).",
  'invalid-git-url':
    'Use owner/repo, an https:// or ssh:// repository URL, git@host:owner/repo.git, or a release, tag or tree page URL.',
  'invalid-git-ref': "The version after @ or # isn't a valid tag, branch or commit name."
}

function parseGitSpec(input: string): { url: string; ref: string } {
  const parsed = parsePluginGitInstallInput(input)
  if (!parsed.ok) {
    throw new PluginCliError('invalid_argument', GIT_INPUT_ERRORS[parsed.reason] ?? parsed.reason, {
      input: parsed.reason === 'git-url-credentials' ? '(redacted)' : input,
      nextSteps: ['Fix the source and run the command again.']
    })
  }
  return { url: parsed.url, ref: parsed.ref }
}

async function candidateFor(
  deps: PluginCliInstallDeps,
  spec: PluginCliInstallSpec
): Promise<PluginCliInstallCandidate> {
  const host = candidateHost(deps)
  switch (spec.kind) {
    case 'catalog':
      return catalogInstallCandidate(host, deps.catalogs, spec.pluginKey, spec.catalog)
    case 'local-path':
      return localInstallCandidate(host, spec.path)
    case 'git': {
      const candidate = await gitInstallCandidate(host, parseGitSpec(spec.input))
      if (!candidate) {
        throw installFailed('Nothing to install.')
      }
      return candidate
    }
  }
}

function locationOf(source: PluginInstallSource): PluginInstallLocation | null {
  switch (source.kind) {
    case 'marketplace':
      return { kind: 'repository', ...source.plugin }
    case 'git':
      return { kind: 'repository', url: source.url }
    case 'local-path':
      return { kind: 'folder', path: source.path }
    case 'bundled':
      return null
  }
}

function locationLabel(location: PluginInstallLocation | null): string {
  if (!location) {
    return 'Orca (bundled)'
  }
  return location.kind === 'folder' ? location.path : pluginSourceLabel(location)
}

/** The repository or folder an install moves from, or null when it stays put. */
export function pluginInstallMove(
  previous: PluginInstallSource,
  next: PluginInstallLocation
): { from: string; to: string } | null {
  const before = locationOf(previous)
  const same =
    before?.kind === 'repository' && next.kind === 'repository'
      ? isSamePluginSource(before, next)
      : before?.kind === 'folder' && next.kind === 'folder' && before.path === next.path
  return same ? null : { from: locationLabel(before), to: locationLabel(next) }
}

/**
 * Decides approval before anything is written, then installs. Code needs `--approve` bound to
 * these bytes; an update keeps its approval only from the same place with no new access.
 */
export async function settlePluginCliCandidate(
  deps: PluginCliInstallDeps,
  candidate: PluginCliInstallCandidate,
  action: 'install' | 'update',
  approvalFingerprint: string | undefined
): Promise<PluginCliInstallOutcome> {
  const { service, applyConsent } = deps
  const { pluginKey } = candidate
  const previous = (await deps.catalogs.installer.readInstallLockfile()).plugins[pluginKey] ?? null
  const predecessor = readApprovedPredecessor(service.options, service.findValidPlugin(pluginKey))
  const repositoryMoved = previous ? pluginInstallMove(previous.source, candidate.location) : null
  const growth = predecessor ? await readPreviewAccessGrowth(predecessor, candidate) : null
  const keepsApproval =
    growth !== null && repositoryMoved === null && !pluginUpdateGrowsAccess(growth)
  // Why: updating a plugin that is not running grants nothing; it stays as the user left it.
  const grants = action === 'install' || predecessor !== null
  const needsFlag = grants && !keepsApproval && pluginNeedsCliApproval(candidate.manifest)
  if (needsFlag) {
    const update: PluginApprovalUpdateInfo | undefined = previous
      ? { fromVersion: previous.version, growth, repositoryMoved }
      : undefined
    const request = buildPluginApprovalRequest(
      {
        pluginKey,
        manifest: candidate.manifest,
        consentFingerprint: candidate.consentFingerprint,
        contentIdentity: candidate.contentHash,
        isDev: false
      },
      action,
      { source: candidate.source, ...(update ? { update } : {}) }
    )
    request.nextSteps.push(
      previous
        ? `Nothing changed: ${pluginKey} ${previous.version} stays as it is until this is approved.`
        : 'Nothing was installed.'
    )
    if (approvalFingerprint !== request.approvalFingerprint) {
      throw new PluginApprovalRequiredError(request, approvalFingerprint !== undefined)
    }
  }
  const outcome = await installCatalogReleaseWithApproval({
    pluginKey,
    pluginService: service,
    install: candidate.install,
    approve: (key, reviewedFingerprint) =>
      applyConsent({ pluginKey: key, reviewedFingerprint, decision: 'approve' })
  })
  if (!outcome.ok) {
    throw installFailed(`Could not install ${pluginKey}: ${outcome.error}`, { pluginKey })
  }
  const approval: PluginCliInstallApproval =
    outcome.needsReview === false
      ? 'kept'
      : !grants
        ? 'not-approved'
        : await approvePluginFromCli({
            service,
            applyConsent,
            pluginKey,
            approvalFingerprint: needsFlag ? approvalFingerprint : undefined,
            action,
            caller: deps.caller
          })
  return {
    pluginKey,
    version: outcome.version,
    previousVersion: previous?.version ?? null,
    contentHash: outcome.contentHash,
    resolvedCommit: outcome.resolvedCommit,
    approval,
    source: candidate.source
  }
}

export async function installPluginFromCli(
  deps: PluginCliInstallDeps,
  spec: PluginCliInstallSpec,
  approvalFingerprint: string | undefined
): Promise<PluginCliInstallOutcome> {
  assertPluginSystemEnabled(deps.service)
  const candidate = await candidateFor(deps, spec)
  try {
    return await settlePluginCliCandidate(deps, candidate, 'install', approvalFingerprint)
  } finally {
    await candidate.dispose()
  }
}

import {
  compareAppVersions,
  isValidAppVersion
} from '../../../shared/app-lifecycle/identity/app-version'
import {
  PLUGIN_APPROVAL_REQUIRED_CODE,
  PLUGIN_NOT_FOUND_CODE,
  PluginApprovalRequiredError,
  PluginCliError,
  type PluginApprovalRequest,
  updateLines
} from '../../../shared/plugins/approval/plugin-cli-approval'
import {
  PLUGIN_COMMIT_PATTERN,
  type PluginLockEntry
} from '../../../shared/plugins/installation/plugin-install-lockfile'
import { catalogUpdateCandidate } from './plugin-cli-catalog-candidates'
import {
  gitInstallCandidate,
  localInstallCandidate,
  type PluginCliInstallCandidate,
  type PluginCliSettledCandidate
} from './plugin-cli-install-candidates'
import {
  candidateHost,
  settlePluginCliCandidate,
  type PluginCliInstallDeps,
  type PluginCliInstallOutcome
} from './plugin-cli-install'
import { approvePluginFromCli } from './plugin-cli-approval'
import { assertPluginSystemEnabled } from '../development/plugin-dev-folders'

export type PluginCliUpdateOutcome =
  | ({ status: 'updated' } & PluginCliInstallOutcome)
  | {
      status: 'up-to-date' | 'pinned'
      pluginKey: string
      version: string
      reason: string
      /** Set when `--approve` enabled the current version. */
      approval?: string
    }

async function updateCandidate(
  deps: PluginCliInstallDeps,
  entry: PluginLockEntry,
  settleDroppedCatalog: boolean
): Promise<PluginCliInstallCandidate | PluginCliSettledCandidate> {
  const host = candidateHost(deps)
  const { source } = entry
  switch (source.kind) {
    case 'bundled':
      return { status: 'pinned', reason: 'It is bundled with Orca and updates with Orca.' }
    case 'marketplace':
      return catalogUpdateCandidate(host, deps.catalogs, entry, settleDroppedCatalog)
    case 'local-path':
      return localInstallCandidate(host, source.path)
    case 'git': {
      if (PLUGIN_COMMIT_PATTERN.test(source.ref)) {
        return {
          status: 'pinned',
          reason: `It is pinned to commit ${source.ref.slice(0, 12)}. Install a tag or branch to follow new versions.`
        }
      }
      // Why: an install from a version tag follows the newest version tag, like a fresh install.
      const followsTags = isValidAppVersion(source.ref)
      const stopped: { settled: PluginCliSettledCandidate | null } = { settled: null }
      const candidate = await gitInstallCandidate(
        host,
        { url: source.url, ref: followsTags ? '' : source.ref },
        (resolved) => {
          if (resolved.commit === entry.resolvedCommit) {
            stopped.settled = { status: 'up-to-date', reason: `${resolved.ref} is installed.` }
          } else if (followsTags && compareAppVersions(resolved.ref, source.ref) <= 0) {
            stopped.settled = {
              status: 'up-to-date',
              reason: `No version newer than ${source.ref}.`
            }
          }
          return stopped.settled ? 'stop' : 'continue'
        }
      )
      return candidate ?? stopped.settled ?? { status: 'up-to-date', reason: 'Nothing newer.' }
    }
  }
}

function isCandidate(
  value: PluginCliInstallCandidate | PluginCliSettledCandidate
): value is PluginCliInstallCandidate {
  return 'install' in value
}

export async function updatePluginFromCli(
  deps: PluginCliInstallDeps,
  pluginKey: string,
  approvalFingerprint: string | undefined,
  options: { settleDroppedCatalog?: boolean } = {}
): Promise<PluginCliUpdateOutcome> {
  assertPluginSystemEnabled(deps.service)
  const entry = (await deps.catalogs.installer.readInstallLockfile()).plugins[pluginKey]
  if (!entry) {
    throw new PluginCliError(
      PLUGIN_NOT_FOUND_CODE,
      `${pluginKey} is not installed on this Orca host.`,
      {
        pluginKey,
        nextSteps: [
          '`orca plugin list` shows installed plugins; development folders update when their files change.'
        ]
      }
    )
  }
  const next = await updateCandidate(deps, entry, options.settleDroppedCatalog === true)
  if (isCandidate(next) && next.contentHash !== entry.contentHash) {
    try {
      return {
        status: 'updated',
        ...(await settlePluginCliCandidate(deps, next, 'update', approvalFingerprint))
      }
    } finally {
      await next.dispose()
    }
  }
  if (isCandidate(next)) {
    await next.dispose()
  }
  const settled = isCandidate(next)
    ? { status: 'up-to-date' as const, reason: 'Nothing newer.' }
    : next
  // Why: an update that installed but could not keep its approval asks to re-run with --approve.
  const approval =
    approvalFingerprint === undefined
      ? undefined
      : await approvePluginFromCli({
          service: deps.service,
          applyConsent: deps.applyConsent,
          pluginKey,
          approvalFingerprint,
          action: 'update',
          caller: deps.caller
        })
  return { ...settled, pluginKey, version: entry.version, ...(approval ? { approval } : {}) }
}

export type PluginCliUpdateAllResult = {
  updates: PluginCliUpdateOutcome[]
  approvals: PluginApprovalRequest[]
  failed: { pluginKey: string; code: string; message: string }[]
}

/** Updates every install it can; approvals and failures are collected, never fatal to the rest. */
export async function updateAllPluginsFromCli(
  deps: PluginCliInstallDeps
): Promise<PluginCliUpdateAllResult> {
  assertPluginSystemEnabled(deps.service)
  const lock = await deps.catalogs.installer.readInstallLockfile()
  const result: PluginCliUpdateAllResult = { updates: [], approvals: [], failed: [] }
  for (const entry of Object.values(lock.plugins)) {
    if (entry.source.kind === 'bundled') {
      continue
    }
    try {
      result.updates.push(
        await updatePluginFromCli(deps, entry.pluginKey, undefined, { settleDroppedCatalog: true })
      )
    } catch (error) {
      if (error instanceof PluginApprovalRequiredError) {
        result.approvals.push(error.data)
      } else {
        result.failed.push({
          pluginKey: entry.pluginKey,
          code:
            error instanceof PluginCliError || error instanceof PluginApprovalRequiredError
              ? error.code
              : 'plugin_install_failed',
          message: error instanceof Error ? error.message : String(error)
        })
      }
    }
  }
  return result
}

/** Why an approval is still owed: the update's own change when it has one, else the request's reason. */
function approvalReasonOf(request: PluginApprovalRequest): string {
  const changes = request.update ? updateLines(request.update, request.version) : []
  return changes.length > 0 ? changes.join(' ') : request.why
}

/** `--all` exits like a single update: approval_required when any plugin waits on approval. */
export function updateAllApprovalError(result: PluginCliUpdateAllResult): PluginCliError | null {
  if (result.approvals.length === 0) {
    return null
  }
  // Why split: an install that landed but still owes approval is not "waiting before it installs".
  const landed = result.approvals.filter((request) => request.installed)
  const waiting = result.approvals.filter((request) => !request.installed)
  const updated = result.updates.filter((outcome) => outcome.status === 'updated')
  const lines = [
    ...(waiting.length > 0
      ? [
          `${waiting.length} plugin update(s) need approval before they install:`,
          ...waiting.map(
            (request) =>
              `- ${request.pluginKey} ${request.version}: ${request.grants.executionDescription} Fingerprint: ${request.approvalFingerprint}`
          )
        ]
      : []),
    ...(landed.length > 0
      ? [
          `${landed.length} plugin update(s) installed, but their approval is still pending:`,
          ...landed.map(
            (request) =>
              `- ${request.pluginKey} ${request.installed?.version ?? request.version} is installed. ${approvalReasonOf(request)} Fingerprint: ${request.approvalFingerprint}`
          )
        ]
      : []),
    ...(updated.length > 0
      ? [
          `Updated: ${updated.map((outcome) => `${outcome.pluginKey} ${outcome.version}`).join(', ')}.`
        ]
      : [])
  ]
  return new PluginCliError(PLUGIN_APPROVAL_REQUIRED_CODE, lines.join('\n'), {
    ...result,
    nextSteps: [
      'Each update below grows access or comes from a different repository. Confirm with your user first.',
      ...result.approvals.map(
        (request) =>
          `To approve ${request.pluginKey}, run: orca plugin update ${request.pluginKey} ${request.approveFlag}`
      )
    ]
  })
}

import {
  PLUGIN_BLOCKED_CODE,
  PLUGIN_INSTALL_FAILED_CODE,
  PLUGIN_NOT_FOUND_CODE,
  PluginCliError
} from '../../shared/plugins/approval/plugin-cli-approval'
import {
  classifyPluginGitAccessFailure,
  GIT_AUTH_FAILED_CODE
} from '../../shared/plugins/installation/plugin-git-access-failure'
import {
  gitInstallSourceInfo,
  localInstallSourceInfo,
  type PluginInstallSourceInfo
} from '../../shared/plugins/installation/plugin-install-source-info'
import type { PluginInstallSource } from '../../shared/plugins/installation/plugin-install-lockfile'
import type { PluginManifest } from '../../shared/plugins/manifest/plugin-manifest'
import type { PluginVmRecipeIdentities } from '../../shared/plugins/approval/plugin-update-access-growth'
import type { PluginMarketplaceInstallResult } from './catalog/plugin-marketplace-installer'
import { resolvePluginGitSource } from './installation/plugin-git-ref-resolution'
import { pluginInstallTrustError } from './installation/plugin-install-trust'
import {
  stagePluginGitInstall,
  stagePluginLocalInstall
} from './installation/plugin-staged-install'
import { getUserPluginsDir } from './plugin-discovery'
import { resolveHostPluginFolder } from './plugin-dev-folders'

/** Where an install's files live, to tell an update from a move to another repository or folder. */
export type PluginInstallLocation =
  | { kind: 'repository'; url: string; path?: string }
  | { kind: 'folder'; path: string }

/** A verified, not yet installed plugin: everything approval needs, and how to install it. */
export type PluginCliInstallCandidate = {
  pluginKey: string
  manifest: PluginManifest
  contentHash: string
  consentFingerprint: string
  resolvedCommit: string | null
  vmRecipeIdentities?: PluginVmRecipeIdentities
  source: PluginInstallSourceInfo
  location: PluginInstallLocation
  install: () => Promise<PluginMarketplaceInstallResult>
  dispose: () => Promise<void>
}

export type PluginCliCandidateHost = {
  userDataPath: string
  hostVersion: string
  /** Named in messages so a credential fix happens on the machine that runs Git. */
  executionHost: string
  blockedPluginReason: (pluginKey: string) => string | null
}

export function installFailed(
  message: string,
  extra: Record<string, unknown> = {}
): PluginCliError {
  return new PluginCliError(PLUGIN_INSTALL_FAILED_CODE, message, {
    ...extra,
    nextSteps: ['Fix the problem above, then run the command again.']
  })
}

/** A Git failure as `git_auth_failed` when this host could not sign in, else a plain install failure. */
export function gitFailure(
  host: Pick<PluginCliCandidateHost, 'executionHost'>,
  url: string,
  error: unknown
): PluginCliError {
  const message = error instanceof Error ? error.message : String(error)
  const access = classifyPluginGitAccessFailure({
    error: message,
    url,
    executionHost: host.executionHost
  })
  if (!access) {
    return installFailed(`Could not download ${url}: ${message}`, { url })
  }
  return new PluginCliError(
    GIT_AUTH_FAILED_CODE,
    `Git on ${access.executionHost} could not read ${url}: the repository does not exist, or that machine's Git credentials cannot access it. Orca runs Git without prompts, so a private repository needs credentials that already work there.`,
    { ...access }
  )
}

/** Refuses kill-listed keys and reserved names before anyone is asked to approve them. */
export function assertInstallAllowed(
  host: PluginCliCandidateHost,
  pluginKey: string,
  lockSource: PluginInstallSource
): void {
  const blocked = host.blockedPluginReason(pluginKey)
  const reason = blocked
    ? `${pluginKey} is blocked by Orca's safety list: ${blocked}`
    : pluginInstallTrustError(pluginKey, lockSource)
  if (reason) {
    throw new PluginCliError(PLUGIN_BLOCKED_CODE, reason, {
      pluginKey,
      nextSteps: ['Do not try to install this plugin another way.']
    })
  }
}

/** Pins a Git input to one commit (no ref: the newest version tag) and stages that commit. */
export async function gitInstallCandidate(
  host: PluginCliCandidateHost,
  input: { url: string; ref: string },
  /** Sees the pinned ref and commit before anything downloads; 'stop' skips the download. */
  onResolved?: (resolved: { ref: string; commit: string }) => 'stop' | 'continue'
): Promise<PluginCliInstallCandidate | null> {
  const resolution = await resolvePluginGitSource(input)
  if (!resolution.ok) {
    if (resolution.reason === 'ref-not-found') {
      throw new PluginCliError(
        PLUGIN_NOT_FOUND_CODE,
        `${input.url} has no tag or branch named ${resolution.ref}.`,
        { url: input.url, ref: resolution.ref, nextSteps: ['Check the version after @ or #.'] }
      )
    }
    throw gitFailure(host, input.url, resolution.error)
  }
  if (onResolved?.(resolution) === 'stop') {
    return null
  }
  const staged = await stagePluginGitInstall({
    pluginsDir: getUserPluginsDir(host.userDataPath),
    url: input.url,
    ref: resolution.ref,
    commit: resolution.commit,
    hostVersion: host.hostVersion,
    blockedPluginReason: host.blockedPluginReason
  }).catch((error: unknown) => {
    throw gitFailure(host, input.url, error)
  })
  try {
    assertInstallAllowed(host, staged.pluginKey, {
      kind: 'git',
      url: input.url,
      ref: resolution.ref
    })
  } catch (error) {
    await staged.dispose()
    throw error
  }
  return {
    ...staged,
    source: gitInstallSourceInfo({
      url: input.url,
      ref: resolution.ref,
      commit: resolution.commit,
      publisher: staged.manifest.publisher
    }),
    location: { kind: 'repository', url: input.url }
  }
}

export async function localInstallCandidate(
  host: PluginCliCandidateHost,
  path: string
): Promise<PluginCliInstallCandidate> {
  const folder = await resolveHostPluginFolder(path)
  const staged = await stagePluginLocalInstall({
    pluginsDir: getUserPluginsDir(host.userDataPath),
    path: folder,
    hostVersion: host.hostVersion,
    blockedPluginReason: host.blockedPluginReason
  }).catch((error: unknown) => {
    throw installFailed(
      `${folder} is not an installable plugin: ${error instanceof Error ? error.message : String(error)}`,
      { path: folder }
    )
  })
  assertInstallAllowed(host, staged.pluginKey, { kind: 'local-path', path: folder })
  return {
    ...staged,
    source: localInstallSourceInfo(folder, staged.manifest.publisher),
    location: { kind: 'folder', path: folder }
  }
}

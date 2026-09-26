import type { OrcaHooks, SetupRunPolicy } from '../../shared/orca-yaml-hook-types'
import type { Repo } from '../../shared/repo-types'
import { isFolderRepo } from '../../shared/repo-kind'
import type { RuntimeRepoList, RuntimeRepoSearchRefs } from '../../shared/runtime-types'
import type { RuntimeClient } from '../runtime-client'
import type { CommandHandler } from '../dispatch'
import { formatRepoList, formatRepoRefs, formatRepoShow, printResult } from '../format'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRequiredStringFlag,
  getRequiredStringFlagAllowingEmpty
} from '../flags'
import { readFileOrStdinText } from '../file-or-stdin-text'
import { resolveRepoPathArgument } from '../repo-path-arguments'
import { RuntimeClientError } from '../runtime/types'
import {
  HOOK_COMMAND_SOURCE_POLICIES,
  SETUP_AGENT_STARTUP_POLICIES,
  SETUP_RUN_POLICIES,
  hasRepoHookSettingsChange,
  mergeRepoHookSettings,
  type RepoHookSettingsChange
} from '../repo-hook-settings'
import { buildRepoHooksView, formatRepoHooks, type RepoHooksView } from '../repo-hooks-format'

type RepoHooksResult = {
  hasHooksFile: boolean
  hooks: OrcaHooks | null
  setupRunPolicy: SetupRunPolicy
}

type RepoHooksCheckResult = {
  status: 'ok' | 'error'
  hasHooks: boolean
  hooks: OrcaHooks | null
}

export const REPO_HANDLERS: Record<string, CommandHandler> = {
  'repo list': async ({ client, json }) => {
    const result = await client.call<RuntimeRepoList>('repo.list')
    printResult(result, json, formatRepoList)
  },
  'repo add': async ({ flags, client, cwd, json }) => {
    const repoPath = getRequiredStringFlag(flags, 'path')
    const result = await client.call<{ repo: Record<string, unknown> }>('repo.add', {
      path: resolveRepoPathArgument(repoPath, cwd, client.isRemote, 'Remote repo add')
    })
    printResult(result, json, formatRepoShow)
  },
  'repo show': async ({ flags, client, json }) => {
    const result = await client.call<{ repo: Record<string, unknown> }>('repo.show', {
      repo: getRequiredStringFlag(flags, 'repo')
    })
    printResult(result, json, formatRepoShow)
  },
  'repo set-base-ref': async ({ flags, client, json }) => {
    const result = await client.call<{ repo: Record<string, unknown> }>('repo.setBaseRef', {
      repo: getRequiredStringFlag(flags, 'repo'),
      ref: getRequiredStringFlag(flags, 'ref')
    })
    printResult(result, json, formatRepoShow)
  },
  'repo search-refs': async ({ flags, client, json }) => {
    const result = await client.call<RuntimeRepoSearchRefs>('repo.searchRefs', {
      repo: getRequiredStringFlag(flags, 'repo'),
      query: getRequiredStringFlag(flags, 'query'),
      limit: getOptionalPositiveIntegerFlag(flags, 'limit')
    })
    printResult(result, json, formatRepoRefs)
  },
  'repo hooks show': async ({ flags, client, json }) => {
    const selector = getRequiredStringFlag(flags, 'repo')
    const repo = await showHookCapableRepo(client, selector)
    printResult(await readRepoHooks(client, selector, repo), json, formatRepoHooks)
  },
  'repo hooks set': async ({ flags, client, cwd, json }) => {
    const selector = getRequiredStringFlag(flags, 'repo')
    // Why: the first read drains stdin, so the second would silently store an empty script.
    if (flags.get('setup-script-file') === '-' && flags.get('archive-script-file') === '-') {
      throw new RuntimeClientError(
        'invalid_argument',
        'Only one of --setup-script-file and --archive-script-file can read from stdin.'
      )
    }
    const change: RepoHookSettingsChange = {
      setupScript: await readScriptFlag(flags, cwd, 'setup-script'),
      archiveScript: await readScriptFlag(flags, cwd, 'archive-script'),
      setupRunPolicy: getPolicyFlag(flags, 'setup-run-policy', SETUP_RUN_POLICIES),
      setupAgentStartupPolicy: getPolicyFlag(flags, 'agent-startup', SETUP_AGENT_STARTUP_POLICIES),
      commandSourcePolicy: getPolicyFlag(flags, 'command-source', HOOK_COMMAND_SOURCE_POLICIES)
    }
    if (!hasRepoHookSettingsChange(change)) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Nothing to change. Pass at least one of --setup-script, --setup-script-file, --archive-script, --archive-script-file, --setup-run-policy, --agent-startup, or --command-source.'
      )
    }
    const repo = await showHookCapableRepo(client, selector)
    const updated = await client.call<{ repo: Repo }>('repo.update', {
      repo: selector,
      updates: { hookSettings: mergeRepoHookSettings(repo.hookSettings, change) }
    })
    printResult(await readRepoHooks(client, selector, updated.result.repo), json, formatRepoHooks)
  }
}

async function showHookCapableRepo(client: RuntimeClient, selector: string): Promise<Repo> {
  const { result } = await client.call<{ repo: Repo }>('repo.show', { repo: selector })
  if (isFolderRepo(result.repo)) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Folder projects have no worktree hooks; setup and archive scripts only run for git projects.'
    )
  }
  return result.repo
}

/** Reads the shared, local, and effective sides the same way the settings pane does. */
async function readRepoHooks(
  client: RuntimeClient,
  selector: string,
  repo: Repo
): Promise<{ id: string; ok: true; result: RepoHooksView; _meta: { runtimeId: string } }> {
  const hooks = await client.call<RepoHooksResult>('repo.hooks', { repo: selector })
  const check = await client.call<RepoHooksCheckResult>('repo.hooksCheck', { repo: selector })
  return {
    ...hooks,
    result: buildRepoHooksView({
      repoId: repo.id,
      displayName: repo.displayName,
      hookSettings: repo.hookSettings,
      effective: hooks.result.hooks,
      sharedCheck: check.result,
      hasHooksFile: hooks.result.hasHooksFile,
      setupRunPolicy: hooks.result.setupRunPolicy
    })
  }
}

async function readScriptFlag(
  flags: Map<string, string | boolean>,
  cwd: string,
  name: string
): Promise<string | undefined> {
  const fileFlag = `${name}-file`
  if (flags.has(name) && flags.has(fileFlag)) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Use either --${name} or --${fileFlag}, not both`
    )
  }
  if (flags.has(fileFlag)) {
    return await readFileOrStdinText(getRequiredStringFlag(flags, fileFlag), cwd, name)
  }
  if (!flags.has(name)) {
    return undefined
  }
  const script = getRequiredStringFlagAllowingEmpty(flags, name)
  // Why: `null` is the CLI's clear sentinel (see --issue/--linear-issue); stored cleared scripts are ''.
  return script === 'null' ? '' : script
}

function getPolicyFlag<T extends string>(
  flags: Map<string, string | boolean>,
  name: string,
  allowed: readonly T[]
): T | undefined {
  const value = getOptionalStringFlag(flags, name)
  if (value === undefined) {
    return undefined
  }
  const policy = allowed.find((entry) => entry === value)
  if (!policy) {
    throw new RuntimeClientError(
      'invalid_argument',
      `--${name} must be one of ${allowed.join(', ')}`
    )
  }
  return policy
}

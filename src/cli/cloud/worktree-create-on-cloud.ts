// Private build only: the `cloud` target for `orca worktree create --on <target>`.
//   orca worktree create --on cloud [--name <n>] [--repo <url-or-path>] [--base-branch <ref>]
//                        [--size standard|large] [--agent claude|codex --prompt <text>] [--json]
//   --on cloud:<project>  uses an Orca Cloud project's repo and environment defaults.
// It creates an Orca Cloud workspace through the public API with the same credentials as
// `orca cloud …`, so it works on a desktop and inside a VM (no Orca runtime involved).
import { runProcessSync } from '@orca/process-host'
import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import type { HandlerContext } from '../dispatch'
import { getOptionalStringFlag } from '../flags'
import { RuntimeClientError } from '../runtime/types'
import { formatCloudWorkspace, printCloudResult } from './cloud-format'
import { cloudProgress, readCloudProgressMode } from './cloud-progress'
import {
  CLOUD_AGENTS,
  cloudClient,
  createCloudWorkspace,
  defaultCloudHandlerDeps,
  getSizeFlag,
  isCloudAgent,
  normalizeCloudRepoUrl,
  resolveCloudProjectId,
  type CloudHandlerDeps,
  type CloudWorkspaceCreateInput
} from './cloud-operations'

export const CLOUD_ON_TARGET = 'cloud'

/** Flags `worktree create` accepts that mean something for a cloud workspace. */
const SUPPORTED = new Set([
  'on',
  'name',
  'repo',
  'base-branch',
  'size',
  'agent',
  'prompt',
  'env',
  'progress',
  'json',
  'help'
])

export type CloudOnDeps = CloudHandlerDeps & {
  /** `git remote get-url origin` for a checkout, or null. */
  originUrl: (dir: string) => string | null
}

function gitOriginUrl(dir: string): string | null {
  try {
    const result = runProcessSync({
      program: 'git',
      args: ['-C', dir, 'remote', 'get-url', 'origin'],
      timeoutMs: 5000
    })
    const out = result.code === 0 ? result.stdout.trim() : ''
    return out || null
  } catch {
    return null
  }
}

export const defaultCloudOnDeps = (): CloudOnDeps => ({
  ...defaultCloudHandlerDeps(),
  originUrl: gitOriginUrl
})

/** `--on cloud` or `--on cloud:<project>`; anything else belongs to the generic --on parser. */
export function readCloudOnTarget(
  flags: Map<string, string | boolean>
): { project: string | null } | null {
  const raw = flags.get('on')
  if (typeof raw !== 'string') {
    return null
  }
  const value = raw.trim()
  if (value === CLOUD_ON_TARGET) {
    return { project: null }
  }
  if (value.startsWith(`${CLOUD_ON_TARGET}:`)) {
    const project = value.slice(CLOUD_ON_TARGET.length + 1).trim()
    if (!project) {
      throw new RuntimeClientError(
        'invalid_argument',
        '--on cloud:<project> needs a project id or name.',
        {
          field: 'on'
        }
      )
    }
    return { project }
  }
  return null
}

function looksLikeGitUrl(value: string): boolean {
  return /^(https?|ssh|git):\/\//.test(value) || /^[\w.-]+@[\w.-]+:/.test(value)
}

/** --repo is a git URL or a local checkout (its origin is used); without it, the cwd checkout. */
export function resolveCloudRepo(
  flags: Map<string, string | boolean>,
  cwd: string,
  originUrl: CloudOnDeps['originUrl']
): { url: string } | null {
  const repo = getOptionalStringFlag(flags, 'repo')
  if (repo && looksLikeGitUrl(repo)) {
    return { url: normalizeCloudRepoUrl(repo) }
  }
  if (repo) {
    const dir = isAbsolute(repo) ? repo : resolve(cwd, repo)
    const origin = existsSync(dir) ? originUrl(dir) : null
    if (!origin) {
      throw new RuntimeClientError(
        'invalid_argument',
        `With --on cloud, --repo is a git URL or a local checkout with an origin remote; "${repo}" is neither.`,
        { field: 'repo' }
      )
    }
    return { url: normalizeCloudRepoUrl(origin) }
  }
  const origin = originUrl(cwd)
  return origin ? { url: normalizeCloudRepoUrl(origin) } : null
}

export async function createWorktreeOnCloud(
  context: Pick<HandlerContext, 'flags' | 'cwd' | 'json'>,
  getDeps: () => CloudOnDeps = defaultCloudOnDeps
): Promise<void> {
  const { flags, cwd, json } = context
  const target = readCloudOnTarget(flags)
  if (!target) {
    throw new RuntimeClientError('invalid_argument', '--on cloud expected.', { field: 'on' })
  }
  const unsupported = [...flags.keys()].filter((name) => !SUPPORTED.has(name))
  if (unsupported.length > 0) {
    throw new RuntimeClientError(
      'invalid_argument',
      `--${unsupported[0]} doesn't apply to --on cloud. Supported: --name, --repo, --base-branch, --env, --size, --agent/--prompt.`,
      { field: unsupported[0] }
    )
  }
  const agent = getOptionalStringFlag(flags, 'agent')
  const prompt = getOptionalStringFlag(flags, 'prompt')
  if (agent !== undefined && !isCloudAgent(agent)) {
    throw new RuntimeClientError(
      'invalid_argument',
      `--on cloud runs ${CLOUD_AGENTS.join(' or ')}; --agent ${agent} is not available there yet.`,
      { field: 'agent' }
    )
  }
  if (prompt && !agent) {
    throw new RuntimeClientError('invalid_argument', '--prompt requires --agent', {
      field: 'agent'
    })
  }
  const progress = readCloudProgressMode(flags, json)
  const deps = getDeps()
  const machineSize = getSizeFlag(flags)
  const ref = getOptionalStringFlag(flags, 'base-branch')
  const repo = target.project ? null : resolveCloudRepo(flags, cwd, deps.originUrl)
  if (ref && !repo && !target.project) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--base-branch needs a repo (--repo or a checkout as cwd).',
      {
        field: 'base-branch'
      }
    )
  }
  const api = cloudClient(deps)
  const name = getOptionalStringFlag(flags, 'name')
  const environment = getOptionalStringFlag(flags, 'env')
  if (environment !== undefined && !/^(env|bld)_[A-Za-z0-9_-]{4,64}$/.test(environment)) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--env takes a team environment id (env_…) or a build id (bld_…).',
      { field: 'env' }
    )
  }
  const input: CloudWorkspaceCreateInput = {
    ...(name ? { name } : {}),
    ...(environment ? { environment } : {}),
    ...(target.project ? { projectId: await resolveCloudProjectId(api, target.project) } : {}),
    ...(repo ? { repo: { url: repo.url, ...(ref ? { ref } : {}) } } : {}),
    ...(machineSize ? { machineSize } : {}),
    ...(prompt && agent ? { message: { text: prompt, agent } } : {})
  }
  const progressLines = cloudProgress(progress)
  progressLines.phase(
    'create',
    `Creating an Orca Cloud workspace${repo ? ` from ${repo.url}` : ''}...`
  )
  const created = await progressLines.track(
    createCloudWorkspace(api, input, deps.now),
    (s) => `Still starting (${s}s). This is taking longer than usual; your files are safe.`
  )
  progressLines.phase(
    'ready',
    `Workspace ${created.workspace.id} is ${created.workspace.status} (took ${progressLines.elapsedSeconds()}s).`,
    { workspaceId: created.workspace.id }
  )
  printCloudResult(
    {
      ...created,
      host: {
        id: created.workspace.id,
        origin: { target: target.project ? `cloud:${target.project}` : CLOUD_ON_TARGET },
        lifecycle: 'per-workspace',
        state: created.workspace.status
      }
    },
    json,
    (value) => formatCloudWorkspace(value, deps.now())
  )
}

/**
 * Private build hook for `worktree create`: the only `--on` target here is Orca Cloud, which talks to
 * the Orca Cloud API instead of the runtime. True when it handled the command.
 */
export async function maybeCreateWorktreeOnCloud(
  context: Pick<HandlerContext, 'flags' | 'cwd' | 'json'>
): Promise<boolean> {
  const { flags } = context
  if (!flags.has('on') && !flags.has('env') && !flags.has('size') && !flags.has('progress')) {
    return false
  }
  if (!readCloudOnTarget(flags)) {
    throw new RuntimeClientError(
      'invalid_argument',
      flags.has('on')
        ? '--on supports `cloud` or `cloud:<project>` in this build.'
        : '--env, --size and --progress apply to `--on cloud`.',
      { field: flags.has('on') ? 'on' : 'env' }
    )
  }
  await createWorktreeOnCloud(context)
  return true
}

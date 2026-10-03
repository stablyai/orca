import {
  LANGUAGE_SERVER_CATALOG,
  type ExternalLanguageServer
} from '../../shared/language-server-catalog'
import {
  LANGUAGE_SERVER_IDS,
  type LanguageServerId,
  type LanguageServerProbe,
  type LspProbeResult
} from '../../shared/language-server-types'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { Repo } from '../../shared/repo-types'
import {
  runProcess,
  type ProcessResult,
  type ProcessSpec
} from '../../shared/child-process/run-process'
import { resolveLoginShellEnvironment } from '../startup/login-shell-environment'
import { resolveCommandOnLocalPath, type ResolveCommandOptions } from '../ipc/command-path-resolver'

export type LspProbeDeps = {
  loginShellEnv: () => Promise<NodeJS.ProcessEnv>
  resolveOnPath: (command: string, options: ResolveCommandOptions) => Promise<string | null>
  run: (spec: ProcessSpec) => Promise<ProcessResult>
}

const defaultDeps: LspProbeDeps = {
  loginShellEnv: () => resolveLoginShellEnvironment(),
  resolveOnPath: resolveCommandOnLocalPath,
  run: runProcess
}

async function probeExternal(
  repo: Repo,
  id: LanguageServerId,
  entry: ExternalLanguageServer,
  deps: LspProbeDeps
): Promise<LanguageServerProbe> {
  const [name, ...args] = repo.languageServers?.command?.[id] ?? entry.defaultCommand
  const env = await deps.loginShellEnv()
  const program = name ? await deps.resolveOnPath(name, { env, cwd: repo.path }) : null
  if (!program) {
    return { status: 'missing' }
  }
  // Why: cwd = project so version-manager shims answer for the project's Ruby, not the global one.
  const run = await deps
    .run({
      program,
      args: [...args, ...entry.versionArgs],
      cwd: repo.path,
      env,
      timeoutMs: 10_000,
      maxOutputBytes: 64 * 1024
    })
    .catch(() => null)
  if (!run || run.code !== 0) {
    return { status: 'missing' }
  }
  return { status: 'installed', version: run.stdout.trim().split('\n')[0] ?? '' }
}

export async function probeRepoLanguageServers(
  repo: Repo,
  deps: LspProbeDeps = defaultDeps
): Promise<LspProbeResult> {
  const local = getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID
  const result: LspProbeResult = {}
  for (const id of LANGUAGE_SERVER_IDS) {
    const entry = LANGUAGE_SERVER_CATALOG[id]
    if (entry.kind === 'bundled') {
      result[id] = { status: 'bundled' }
    } else if (!local) {
      result[id] = { status: 'unsupported-host' }
    } else if (repo.languageServers?.enabled?.[id]) {
      // Why: probing runs the (possibly repo-controlled) command, so only an opted-in server is run.
      result[id] = await probeExternal(repo, id, entry, deps)
    }
  }
  return result
}

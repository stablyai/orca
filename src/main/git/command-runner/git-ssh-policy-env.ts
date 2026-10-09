import { addWslEnvKeys } from '../../wsl-env'
import {
  buildGitSshPolicyEnv,
  GIT_SSH_CONFIG_ARGS,
  parseGitSshConfig,
  type GitSshPolicyMode
} from '../../../shared/git-ssh-policy-env'
import { findGitSubcommandIndex } from '../../../shared/git-command-classification'
import { execFileCapture } from './exec-file-capture'
import { resolveGitCommand } from './git-command-resolution'
import { DEFAULT_GIT_MAX_BUFFER, type GitExecOptions } from './git-exec-options'
import { promptGuardGitEnv } from './git-process-env'
import { acquireGitAdmission } from './git-subprocess-admission'

export type { GitSshPolicyMode } from '../../../shared/git-ssh-policy-env'

const CORE_SSH_COMMAND_PROBE_TIMEOUT_MS = 2500
// Cold WSL starts and login rc files need the environment probe's startup budget.
const WSL_CORE_SSH_COMMAND_PROBE_TIMEOUT_MS = 10_000

export async function buildNetworkSshPolicyEnv(
  options: GitExecOptions,
  args: readonly string[] = []
): Promise<{
  env: NodeJS.ProcessEnv
  mode: GitSshPolicyMode
}> {
  const promptEnv = promptGuardGitEnv(options.env)
  if (promptEnv.GIT_SSH_COMMAND || promptEnv.GIT_SSH) {
    return { env: promptEnv, mode: 'explicit-env' }
  }

  // A login-shell banner must not become a configured SSH command.
  const subcommandIndex = findGitSubcommandIndex(args)
  const probeArgs = [...args.slice(0, Math.max(0, subcommandIndex)), ...GIT_SSH_CONFIG_ARGS]
  const resolved = resolveGitCommand(probeArgs, options, true, true)
  const grant = await acquireGitAdmission({
    args: probeArgs,
    cwd: options.cwd,
    wslDistro: options.wslDistro,
    tier: options.admissionTier,
    signal: options.signal
  })
  let reportTerminated: () => void = () => {}
  const terminated = new Promise<void>((resolve) => {
    reportTerminated = resolve
  })
  let configured = parseGitSshConfig('')
  try {
    const { stdout } = await execFileCapture(resolved.binary, resolved.args, {
      cwd: resolved.cwd,
      encoding: 'utf-8',
      maxBuffer: DEFAULT_GIT_MAX_BUFFER,
      timeout: Math.min(
        options.timeout && options.timeout > 0 ? options.timeout : Infinity,
        resolved.wsl ? WSL_CORE_SSH_COMMAND_PROBE_TIMEOUT_MS : CORE_SSH_COMMAND_PROBE_TIMEOUT_MS
      ),
      env: promptEnv,
      signal: options.signal,
      onChildTerminated: reportTerminated
    })
    const payload = resolved.captured?.readStdout(String(stdout)) ?? String(stdout)
    configured = parseGitSshConfig(payload)
  } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 1) {
      throw error
    }
  } finally {
    void terminated.then(grant.release)
  }

  const policy = buildGitSshPolicyEnv(promptEnv, configured.command, configured.variant)
  if (resolved.wsl && policy.env.GIT_SSH_COMMAND && policy.env !== promptEnv) {
    addWslEnvKeys(policy.env, ['GIT_SSH_COMMAND'])
  }
  return policy
}

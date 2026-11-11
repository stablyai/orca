import { access, mkdtemp, readFile, rm, stat, statfs, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import {
  findCommandsOnLocalPath,
  resolveCommandOnLocalPath
} from '../ipc/command-path/command-path-resolver'
import { hydrateShellPathForAgentDetection } from '../ipc/command-path/agent-detection-shell-path'
import { buildLocalPreflightEnv } from '../ipc/preflight-local-env'
import { detectInstalledAgents } from '../preflight/installed-agent-detection'
import { resolveGitBashPath } from '../pty/shell-startup/git-bash'
import {
  buildPosixRunnerScript,
  buildWindowsRunnerScript
} from '../workspace-hooks/setup-runner-script-text'
import { getSetupEnvVars } from '../workspace-hooks/setup-hook-env-vars'
import { gitCredentialPromptGuardEnv } from '../../shared/git/commands/git-credential-prompt-env'
import { scriptDeclaresPosixShell } from '../../shared/workspace-setup/setup-script-shebang'
import type { EnvironmentDoctorCommandResult, EnvironmentDoctorDeps } from './environment-doctor'

const SETUP_TIMEOUT_MS = 30 * 60_000
const SETUP_OUTPUT_BYTES = 256 * 1024

/** Real host I/O for the doctor; it runs on the machine that owns the checkout. */
export function createHostEnvironmentDoctorDeps(
  options: {
    /** Long-lived servers re-read the login shell so a retry sees tools installed since startup. */
    refreshShellPath?: boolean
  } = {}
): EnvironmentDoctorDeps {
  const baseEnv = (): NodeJS.ProcessEnv => buildLocalPreflightEnv() ?? process.env
  const run: EnvironmentDoctorDeps['run'] = async (program, args, options) => {
    // Git probes also force the C locale: folder detection reads Git's English "not a git repository".
    const env = options.guardGitPrompts
      ? { ...gitCredentialPromptGuardEnv(baseEnv()), LC_ALL: 'C', LANGUAGE: 'C' }
      : baseEnv()
    // Windows npm shims are .cmd files that a bare name cannot spawn.
    const resolved =
      process.platform === 'win32'
        ? ((await resolveCommandOnLocalPath(program, { env })) ?? program)
        : program
    return toResult(
      await runProcess(
        { program: resolved, args, cwd: options.cwd, env, timeoutMs: options.timeoutMs },
        'tail'
      )
    )
  }
  return {
    platform: process.platform,
    // Agent detection's login-shell PATH, applied before any probe so all checks agree.
    prepare: () => hydrateShellPathForAgentDetection(undefined, options.refreshShellPath === true),
    run,
    findCommands: (commands) => findCommandsOnLocalPath(commands, { env: baseEnv() }),
    detectAgents: () => detectInstalledAgents(),
    readFile: (path) => readFile(path, 'utf8').catch(() => null),
    exists: (path) =>
      access(path).then(
        () => true,
        () => false
      ),
    isDirectory: async (path) => (await stat(path).catch(() => null))?.isDirectory() ?? false,
    freeBytes: async (path) => {
      const stats = await statfs(path)
      return Number(stats.bavail) * Number(stats.bsize)
    },
    runSetupScript: async ({ worktreePath, rootPath, script }) => {
      const dir = await mkdtemp(join(tmpdir(), 'orca-env-doctor-'))
      try {
        // Like Orca's runner: Windows uses cmd unless the script's shebang asks for a POSIX shell.
        const bash =
          process.platform !== 'win32'
            ? 'bash'
            : scriptDeclaresPosixShell(script)
              ? resolveGitBashPath()
              : null
        const runnerPath = join(dir, bash ? 'setup-runner.sh' : 'setup-runner.cmd')
        await writeFile(
          runnerPath,
          bash ? buildPosixRunnerScript(script) : buildWindowsRunnerScript(script),
          'utf8'
        )
        // Unattended like Orca's setup run: no credential prompt can wait on a terminal.
        const env = gitCredentialPromptGuardEnv({
          ...baseEnv(),
          ...getSetupEnvVars({ path: rootPath }, worktreePath)
        })
        return toResult(
          await runProcess(
            {
              program: bash ?? runnerPath,
              args: bash ? [runnerPath] : [],
              cwd: worktreePath,
              env,
              timeoutMs: SETUP_TIMEOUT_MS,
              maxOutputBytes: SETUP_OUTPUT_BYTES
            },
            'tail'
          )
        )
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    }
  }
}

function toResult(result: Awaited<ReturnType<typeof runProcess>>): EnvironmentDoctorCommandResult {
  return {
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut
  }
}

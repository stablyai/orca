import type {
  EnvironmentDoctorCategory,
  EnvironmentDoctorCheck,
  EnvironmentDoctorCheckStatus
} from '../../shared/environment-doctor-types'
import { stripCredentialsFromMessage } from '../../shared/git/remotes/git-remote-error'

export type EnvironmentDoctorCommandResult = {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export type EnvironmentDoctorRunOptions = {
  cwd: string
  timeoutMs: number
  /** Disable Git credential UI so a probe fails fast instead of waiting on a prompt. */
  guardGitPrompts?: boolean
}

export type EnvironmentDoctorDeps = {
  platform: NodeJS.Platform
  /** Settle PATH once before any probe, so every check sees the same tools. */
  prepare: () => Promise<void>
  run: (
    program: string,
    args: readonly string[],
    options: EnvironmentDoctorRunOptions
  ) => Promise<EnvironmentDoctorCommandResult>
  findCommands: (commands: readonly string[]) => Promise<Set<string>>
  detectAgents: () => Promise<string[]>
  readFile: (path: string) => Promise<string | null>
  exists: (path: string) => Promise<boolean>
  isDirectory: (path: string) => Promise<boolean>
  freeBytes: (path: string) => Promise<number | null>
  /** Runs scripts.setup the way Orca's setup runner does; only called with runSetup. */
  runSetupScript: (args: {
    worktreePath: string
    rootPath: string
    script: string
  }) => Promise<EnvironmentDoctorCommandResult>
}

export type EnvironmentDoctorOptions = {
  worktreePath: string
  /** Re-run scripts.setup and gate on its exit code; it can take minutes and mutate the checkout. */
  runSetup?: boolean
}

export const PROBE_TIMEOUT_MS = 10_000
const OUTPUT_TAIL_CHARS = 1_500

export async function runSafely(
  deps: EnvironmentDoctorDeps,
  program: string,
  args: readonly string[],
  options: EnvironmentDoctorRunOptions
): Promise<EnvironmentDoctorCommandResult> {
  try {
    return await deps.run(program, args, options)
  } catch (error) {
    return {
      code: null,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
      timedOut: false
    }
  }
}

export function withOutputTail(advice: string, result: EnvironmentDoctorCommandResult): string {
  // Redact before trimming: a cut inside a URL would hide its scheme from the redactor.
  const output = stripCredentialsFromMessage(result.stderr.trim() || result.stdout.trim()).slice(
    -OUTPUT_TAIL_CHARS
  )
  return output ? `${advice}\n${output}` : advice
}

export function check(
  category: EnvironmentDoctorCategory,
  id: string,
  status: EnvironmentDoctorCheckStatus,
  message: string,
  extra: { remediation?: string } = {}
): EnvironmentDoctorCheck {
  return { id, category, status, message, ...extra }
}

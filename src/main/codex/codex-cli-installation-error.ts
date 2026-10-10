import type { CodexInstallationProblem } from '../../shared/codex-cli-installation'
import { sayAgentSessionFailureEnglish } from '../../shared/agent-session-failure-copy'
import { readCodexCliInstallation } from '../preflight/codex-cli-installation'
import { AgentSessionPreSpawnError } from '../native-chat/agent-session-wire/structured-agent-session-adapter'

export class CodexCliInstallationError extends AgentSessionPreSpawnError {
  readonly codexInstallation: CodexInstallationProblem

  constructor(problem: CodexInstallationProblem) {
    super(
      sayAgentSessionFailureEnglish(
        problem.installedVersion === null ? 'codexCliMissing' : 'codexCliTooOld',
        { installedVersion: problem.installedVersion ?? '', minimumVersion: problem.minimumVersion }
      )
    )
    this.codexInstallation = problem
  }
}

export function codexInstallationProblemOf(
  error: unknown,
  depth = 0
): CodexInstallationProblem | undefined {
  if (depth >= 6 || !(error instanceof Error)) {
    return undefined
  }
  if (error instanceof CodexCliInstallationError) {
    return error.codexInstallation
  }
  return codexInstallationProblemOf(error.cause, depth + 1)
}

export async function requireSupportedCodexCli(
  input: Parameters<typeof readCodexCliInstallation>[0],
  readInstallation: typeof readCodexCliInstallation = readCodexCliInstallation
): Promise<void> {
  const result = await readInstallation(input)
  if (result.status === 'missing' || result.status === 'unsupported') {
    throw new CodexCliInstallationError({
      installedVersion: result.version,
      minimumVersion: result.minimumVersion
    })
  }
  if (result.status === 'unknown') {
    console.warn(`[codex-cli-version] Could not verify ${input.program}; allowing structured chat`)
  }
}

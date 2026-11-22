import { claudeLimitLine } from '../../claude/structured/journal/claude-limit-line'
import { stripAnsiControlSequences } from '../../../shared/source-control/ai/generation/commit-message-agent-output'
import type { AgentGenerationFailureOutput } from './agent-failure-output'

// `codex exec` prints a failed turn as one line, after an optional timestamp and "ERROR:".
const CODEX_USAGE_LIMIT =
  /^(?:\[[^\]]+\]\s*)?(?:ERROR:\s*)?You(?:'|\u2019)ve hit your usage limit\.(?:\s|$)/

/** True only for the CLI's own subscription-limit refusal on a failed exit, never for model prose. */
export function isSubscriptionQuotaRefusal(
  agentId: string,
  output: AgentGenerationFailureOutput | undefined,
  now = Date.now()
): boolean {
  if (!output || output.exitCode === null || output.exitCode === 0) {
    return false
  }
  const lines = `${output.stdout}\n${output.stderr}`
    .split(/\r?\n/)
    .map((line) => stripAnsiControlSequences(line).trim())
  if (agentId === 'claude') {
    // `-p --output-format text` prints the refused turn's result: the CLI's own limit line.
    return lines.some((line) => claudeLimitLine(line, now) !== null)
  }
  return agentId === 'codex' && lines.some((line) => CODEX_USAGE_LIMIT.test(line))
}

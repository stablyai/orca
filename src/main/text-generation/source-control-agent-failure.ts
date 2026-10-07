import {
  cleanGeneratedCommitMessage,
  excerptAgentFailureOutput,
  sanitizeAgentFailureDetail
} from '../../shared/commit-message-prompt'
import { withMacTailscaleDnsHint } from '../network/macos-tailscale-dns-diagnostic'
import {
  captureAgentGenerationFailureOutput,
  type AgentGenerationFailureOutput
} from './agent-failure-output'
import type { InternalTextGenerationResult } from './source-control-text-generation-types'
import { parseOpenCodeGenerationOutput } from '../../shared/opencode-generation-output'

export function formatAgentCliFailureMessage(
  label: string,
  stdout: string,
  stderr: string,
  exitCode: number | null,
  options?: { includeLocalMacDnsHint?: boolean; includeStdoutDetail?: boolean }
): string {
  const detail = sanitizeAgentFailureDetail(
    excerptAgentFailureOutput(options?.includeStdoutDetail === false ? '' : stdout, stderr)
  )
  const message =
    exitCode === null
      ? detail
        ? `${label} CLI command was terminated before exiting: ${detail}`
        : `${label} CLI command was terminated before exiting.`
      : detail
        ? `${label} CLI command failed with code ${exitCode}: ${detail}`
        : `${label} CLI command failed with code ${exitCode}.`
  return options?.includeLocalMacDnsHint === false
    ? message
    : withMacTailscaleDnsHint(message, detail)
}

export function userFacingUnsafeWindowsBatchArgs(label: string): string {
  return `${label} cannot be run as a Windows batch command with the prompt in argv. Remove {prompt} so Orca sends the prompt on stdin.`
}

export function finalizeFromAgentOutput(args: {
  code: number | null
  stdout: string
  stderr: string
  label: string
  emptyResultName: string
  includeLocalMacDnsHint?: boolean
  includeStdoutDetail?: boolean
  outputFormat?: 'opencode-json'
}): InternalTextGenerationResult {
  const { code, stdout, stderr, label, emptyResultName } = args
  const parsed =
    args.outputFormat === 'opencode-json' ? parseOpenCodeGenerationOutput(stdout) : null
  if (code !== 0) {
    console.error('[commit-message] Generator failed:', { label, exitCode: code, stdout, stderr })
    return {
      success: false,
      error: formatAgentCliFailureMessage(
        label,
        stdout,
        parsed && !parsed.ok && parsed.error !== 'OpenCode returned invalid JSON events.'
          ? parsed.error
          : stderr,
        code,
        args
      ),
      failureOutput: captureFailureOutput(label, code, stdout, stderr)
    }
  }
  if (parsed && !parsed.ok) {
    return {
      success: false,
      error: sanitizeAgentFailureDetail(parsed.error) ?? 'OpenCode reported an error.',
      failureOutput: captureFailureOutput(label, code, stdout, stderr)
    }
  }
  const cleaned = cleanGeneratedCommitMessage(parsed?.ok ? parsed.text : stdout)
  if (cleaned) {
    return { success: true, rawOutput: cleaned, agentLabel: label }
  }
  const detail = sanitizeAgentFailureDetail(excerptAgentFailureOutput('', stderr))
  if (detail) {
    console.error('[commit-message] Generator returned no stdout but wrote to stderr:', {
      label,
      exitCode: code,
      stdout,
      stderr
    })
  }
  return {
    success: false,
    error: detail
      ? `${label} returned an empty ${emptyResultName}. CLI output: ${detail}`
      : `${label} returned an empty ${emptyResultName}.`,
    failureOutput: captureFailureOutput(label, code, stdout, stderr)
  }
}

function captureFailureOutput(
  label: string,
  code: number | null,
  stdout: string,
  stderr: string
): AgentGenerationFailureOutput | undefined {
  return captureAgentGenerationFailureOutput(label, code, stdout, stderr) ?? undefined
}

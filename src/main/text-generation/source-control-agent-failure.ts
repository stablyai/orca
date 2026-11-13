import {
  cleanGeneratedText,
  excerptAgentFailureOutput,
  sanitizeAgentFailureDetail
} from '../../shared/source-control/ai/generation/commit-message-agent-output'
import { withMacTailscaleDnsHint } from '../network/macos-tailscale-dns-diagnostic'
import {
  captureAgentGenerationFailureOutput,
  type AgentGenerationFailureOutput
} from './agent-failure-output'
import type {
  InternalTextGenerationResult,
  TextGenerationOperation
} from './source-control-text-generation-types'
import { parseOpenCodeGenerationOutput } from '../../shared/opencode-generation-output'
import { parseAntigravityGenerationOutput } from '../../shared/antigravity-generation-stream'
import {
  findKimiGenerationFailure,
  parseKimiGenerationOutput
} from '../../shared/kimi-generation-output'
import { formatKimiGenerationFailure } from './kimi-generation-failure'
import type { CommitMessagePlan } from '../../shared/source-control/ai/generation/commit-message-plan'
import {
  textGenerationFailure,
  type TextGenerationFailureFields
} from '../../shared/text-generation-failure-copy'

// Their stdout is a name or the user's own dictated words, not a diagnostic worth keeping in the error.
const OPERATIONS_WITHOUT_STDOUT_DETAIL: ReadonlySet<TextGenerationOperation> = new Set([
  'branch-name',
  'conversation-name',
  'dictation-cleanup'
])

/** The agent's answer without CLI framing; dictated text keeps the lines and markers Git text drops. */
export function cleanAgentAnswer(raw: string, operation: TextGenerationOperation): string {
  return cleanGeneratedText(raw, operation === 'dictation-cleanup' ? 'prose' : 'git')
}

type AgentCliFailureOptions = {
  includeLocalMacDnsHint?: boolean
  includeStdoutDetail?: boolean
}

export function formatAgentCliFailureMessage(
  label: string,
  stdout: string,
  stderr: string,
  exitCode: number | null,
  options?: AgentCliFailureOptions
): string {
  return agentCliFailure(label, stdout, stderr, exitCode, options).error
}

function agentCliFailure(
  label: string,
  stdout: string,
  stderr: string,
  exitCode: number | null,
  options?: AgentCliFailureOptions
): TextGenerationFailureFields {
  const detail = sanitizeAgentFailureDetail(
    excerptAgentFailureOutput(options?.includeStdoutDetail === false ? '' : stdout, stderr)
  )
  const failure =
    exitCode === null
      ? detail
        ? textGenerationFailure('cliTerminatedWithDetail', { label, detail })
        : textGenerationFailure('cliTerminated', { label })
      : detail
        ? textGenerationFailure('cliFailedWithDetail', {
            label,
            exitCode,
            detail
          })
        : textGenerationFailure('cliFailed', { label, exitCode })
  if (options?.includeLocalMacDnsHint === false) {
    return failure
  }
  const hinted = withMacTailscaleDnsHint(failure.error, detail)
  // The appended DNS hint is English-only, so a hinted message stays uncoded.
  return hinted === failure.error ? failure : { error: hinted }
}

export function userFacingUnsafeWindowsBatchArgs(label: string): TextGenerationFailureFields {
  return textGenerationFailure('windowsBatchUnsafeArguments', { label })
}

const EMPTY_RESULT_FAILURES = {
  'commit-message': ['emptyCommitMessage', 'emptyCommitMessageWithDetail'],
  'pull-request-fields': ['emptyPullRequestDetails', 'emptyPullRequestDetailsWithDetail'],
  'jira-issue-summary': ['emptyJiraSummary', 'emptyJiraSummaryWithDetail']
} as const

const UNCODED_EMPTY_RESULT_NAMES = {
  'branch-name': 'branch name',
  'conversation-name': 'chat name',
  'dictation-cleanup': 'cleanup'
} as const

export function emptyResultFailure(
  operation: TextGenerationOperation,
  label: string,
  detail?: string | null
): TextGenerationFailureFields {
  if (
    operation === 'branch-name' ||
    operation === 'conversation-name' ||
    operation === 'dictation-cleanup'
  ) {
    // Background rename failures are stored as English rename errors, outside the coded result path.
    const name = UNCODED_EMPTY_RESULT_NAMES[operation]
    return {
      error: detail
        ? `${label} returned an empty ${name}. CLI output: ${detail}`
        : `${label} returned an empty ${name}.`
    }
  }
  const [plain, withDetail] = EMPTY_RESULT_FAILURES[operation]
  return detail
    ? textGenerationFailure(withDetail, { label, detail })
    : textGenerationFailure(plain, { label })
}

export function finalizeFromAgentOutput(args: {
  code: number | null
  stdout: string
  stderr: string
  label: string
  operation: TextGenerationOperation
  includeLocalMacDnsHint?: boolean
  includeStdoutDetail?: boolean
  outputFormat?: CommitMessagePlan['outputFormat']
}): InternalTextGenerationResult {
  const { code, stdout, stderr, label } = args
  const options = {
    ...args,
    includeStdoutDetail:
      args.includeStdoutDetail ?? !OPERATIONS_WITHOUT_STDOUT_DETAIL.has(args.operation)
  }
  const parsed =
    args.outputFormat === 'opencode-json'
      ? parseOpenCodeGenerationOutput(stdout)
      : args.outputFormat === 'antigravity-stream-json'
        ? parseAntigravityGenerationOutput(stdout)
        : args.outputFormat === 'kimi-stream-json' && code === 0
          ? parseKimiGenerationOutput(stdout)
          : null
  if (code !== 0) {
    console.error('[commit-message] Generator failed:', {
      label,
      exitCode: code,
      stdout,
      stderr
    })
    return {
      success: false,
      ...(args.outputFormat === 'kimi-stream-json'
        ? formatKimiGenerationFailure(findKimiGenerationFailure(stdout), stderr, code, options)
        : agentCliFailure(
            label,
            stdout,
            // Orca's own parse failures (coded) say nothing about why the agent exited.
            parsed && !parsed.ok && parsed.errorCode === undefined ? parsed.error : stderr,
            code,
            options
          )),
      failureOutput: captureFailureOutput(label, code, stdout, stderr)
    }
  }
  if (parsed && !parsed.ok) {
    const reported = sanitizeAgentFailureDetail(parsed.error)
    return {
      success: false,
      ...(parsed.errorCode !== undefined
        ? { error: parsed.error, errorCode: parsed.errorCode }
        : reported !== null
          ? { error: reported }
          : textGenerationFailure('agentReportedError', { label })),
      failureOutput: captureFailureOutput(label, code, stdout, stderr)
    }
  }
  const cleaned = cleanAgentAnswer(parsed?.ok ? parsed.text : stdout, args.operation)
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
    ...emptyResultFailure(
      args.operation,
      label,
      args.outputFormat !== 'kimi-stream-json' ? detail : null
    ),
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

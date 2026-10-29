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
import type { CommitMessagePlan } from '../../shared/commit-message-plan'
import {
  textGenerationFailure,
  type TextGenerationFailureFields
} from '../../shared/text-generation-failure-copy'

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
  'conversation-name': 'chat name'
} as const

export function emptyResultFailure(
  operation: TextGenerationOperation,
  label: string,
  detail?: string | null
): TextGenerationFailureFields {
  if (operation === 'branch-name' || operation === 'conversation-name') {
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
        ? {
            error: formatKimiGenerationFailure(
              findKimiGenerationFailure(stdout),
              stderr,
              code,
              args
            )
          }
        : agentCliFailure(
            label,
            stdout,
            parsed &&
              !parsed.ok &&
              (args.outputFormat === 'opencode-json'
                ? parsed.error !== 'OpenCode returned invalid JSON events.'
                : parsed.error !== 'Antigravity returned invalid JSON events.' &&
                  parsed.error !== 'Antigravity returned an invalid result.' &&
                  parsed.error !== 'Antigravity returned no final result.')
              ? parsed.error
              : stderr,
            code,
            args
          )),
      failureOutput: captureFailureOutput(label, code, stdout, stderr)
    }
  }
  if (parsed && !parsed.ok) {
    const reported = sanitizeAgentFailureDetail(parsed.error)
    return {
      success: false,
      ...(reported !== null
        ? { error: reported }
        : textGenerationFailure('agentReportedError', { label })),
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

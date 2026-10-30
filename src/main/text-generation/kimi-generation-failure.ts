import { stripAnsiControlSequences } from '../../shared/commit-message-agent-output'
import { withMacTailscaleDnsHint } from '../network/macos-tailscale-dns-diagnostic'
import {
  textGenerationFailure,
  type TextGenerationFailureFields
} from '../../shared/text-generation-failure-copy'

function emptyInputFailure(input: string): TextGenerationFailureFields | null {
  switch (input) {
    case 'Prompt':
      return textGenerationFailure('kimiEmptyPrompt')
    case 'Model':
      return textGenerationFailure('kimiEmptyModel')
    case 'Agent':
      return textGenerationFailure('kimiEmptyAgent')
    case 'Agent file path':
      return textGenerationFailure('kimiEmptyAgentFilePath')
    default:
      return null
  }
}

function isKimiOptionError(line: string): boolean {
  const prefix = "error: option '"
  if (!line.startsWith(prefix) || /[\r\n\u2028\u2029]/.test(line)) {
    return false
  }
  const argument = line.indexOf("' argument '", prefix.length + 1)
  const reason =
    argument === -1 ? -1 : line.indexOf("' is invalid. ", argument + "' argument '".length + 1)
  const conflict = line.indexOf("' cannot be used with option '", prefix.length + 1)
  return (
    (line.endsWith("' argument missing") &&
      line.length > prefix.length + "' argument missing".length) ||
    (reason !== -1 && reason + "' is invalid. ".length < line.length) ||
    (conflict !== -1 &&
      line.endsWith("'") &&
      conflict + "' cannot be used with option '".length < line.length - 1)
  )
}

export function formatKimiGenerationFailure(
  declared: TextGenerationFailureFields | null,
  stderr: string,
  code: number | null,
  options: { includeLocalMacDnsHint?: boolean }
): TextGenerationFailureFields {
  if (declared) {
    return declared
  }
  const failure =
    stderrDiagnosis(stripAnsiControlSequences(stderr)) ??
    textGenerationFailure(code === null ? 'kimiInterrupted' : 'kimiFailed')
  if (options.includeLocalMacDnsHint === false) {
    return failure
  }
  const hinted = withMacTailscaleDnsHint(failure.error, stderr)
  // The appended DNS hint is English-only, so a hinted message stays uncoded.
  return hinted === failure.error ? failure : { error: hinted }
}

function stderrDiagnosis(stderr: string): TextGenerationFailureFields | null {
  // Only the CLI's terminal error lines select copy; hook narration is not a diagnosis.
  for (const line of stderr.split(/\r?\n/)) {
    if (
      line === "error: option '--agent <name>' cannot be used with option '--agent-file <path>'" ||
      /^error: option '--agent <name>' argument '.+' is invalid\. --agent may only be specified once\.$/.test(
        line
      ) ||
      /^error: option '--agent-file <path>' argument '.+' is invalid\. --agent-file may only be specified once\.$/.test(
        line
      )
    ) {
      return textGenerationFailure('kimiAgentOptionsConflict')
    }
    if (
      isKimiOptionError(line) ||
      /^error: unknown option '.+'$/.test(line) ||
      /^unknown command '.+'\. See 'kimi --help'\.$/.test(line)
    ) {
      return textGenerationFailure('kimiOptionRejected')
    }
    const terminal = /^error: (?:failed to run prompt: )?(.+)$/.exec(line)?.[1]
    if (!terminal) {
      continue
    }
    if (/^Session "[^"\r\n]*" not found\.$/.test(terminal) || terminal === 'Session not found') {
      return textGenerationFailure('kimiSessionNotFound')
    }
    if (/^Session "[^"\r\n]*" was created under a different directory\.$/.test(terminal)) {
      return textGenerationFailure('kimiSessionOtherDirectory')
    }
    if (
      /^Provider "[^"\r\n]*" declares api_key_env = "[^"\r\n]*" in config\.toml, but the environment variable is not set or is empty\.$/.test(
        terminal
      )
    ) {
      return textGenerationFailure('kimiCredentialVariableMissing')
    }
    if (
      terminal ===
        'no provider configured; complete onboarding via /login or the providers endpoint' ||
      /^provider .+ has no credential configured$/.test(terminal) ||
      terminal === 'Login required'
    ) {
      return textGenerationFailure('kimiCredentialsRequired')
    }
    if (
      terminal === 'no default model configured' ||
      /^model .+ does not resolve to a configured provider$/.test(terminal) ||
      terminal.startsWith('No model configured. Run `kimi` and use /login') ||
      terminal === 'No model configured' ||
      terminal === 'Invalid model configuration'
    ) {
      return textGenerationFailure('kimiModelMissing')
    }
    if (
      terminal === 'Prompt hook blocked the request.' ||
      terminal === 'Prompt turn could not be started'
    ) {
      return textGenerationFailure('kimiPromptHookBlocked')
    }
    if (terminal === 'Prompt turn ended with reason: cancelled') {
      return textGenerationFailure('kimiCancelled')
    }
    const emptyInput = emptyInputFailure(
      /^(Prompt|Model|Agent|Agent file path) cannot be empty\.$/.exec(terminal)?.[1] ?? ''
    )
    if (emptyInput) {
      return emptyInput
    }
    if (
      terminal === 'Output format is only supported in prompt mode.' ||
      /^Invalid KIMI_MODEL_OUTPUT_FORMAT value "[^"\r\n]*"\. Expected one of: text, stream-json\.$/.test(
        terminal
      )
    ) {
      return textGenerationFailure('kimiOutputFormatInvalid')
    }
    if (terminal === 'Cannot use --session without an id in prompt mode.') {
      return textGenerationFailure('kimiSessionIdRequired')
    }
    if (terminal === 'Cannot combine --continue, --session.') {
      return textGenerationFailure('kimiContinueSessionConflict')
    }
    const conflict =
      /^Cannot combine (--prompt) with (--(?:yolo|auto|plan))\.$|^Cannot combine (--yolo) with (--auto)\.$/.exec(
        terminal
      )
    if (conflict) {
      return textGenerationFailure('kimiConflictingOptions', {
        option: conflict[1] ?? conflict[3],
        otherOption: conflict[2] ?? conflict[4]
      })
    }
    if (
      terminal ===
      'Cannot combine --agent/--agent-file with --session/--continue: the agent is bound at session creation and the bound agent is restored automatically on resume.'
    ) {
      return textGenerationFailure('kimiAgentChangeOnResume')
    }
    if (
      terminal === 'Provider safety policy blocked the response.' ||
      terminal === 'Provider filtered response'
    ) {
      return textGenerationFailure('kimiResponseBlocked')
    }
    const category =
      /^(provider\.[a-z_]+|context\.overflow|config\.invalid):(?: |$)/.exec(terminal)?.[1] ??
      terminal
    switch (category) {
      case 'provider.auth_error':
      case 'Provider authentication error':
        return textGenerationFailure('kimiAuthFailed')
      case 'provider.connection_error':
      case 'Provider connection error':
        return textGenerationFailure('kimiConnectionFailed')
      case 'provider.rate_limit':
      case 'provider.overloaded':
      case 'Provider rate limit':
        return textGenerationFailure('kimiProviderLimited')
      case 'context.overflow':
      case 'Context window overflow':
        return textGenerationFailure('kimiContextOverflow')
      case 'config.invalid':
      case 'Invalid configuration':
        return textGenerationFailure('kimiConfigInvalid')
    }
  }
  return null
}

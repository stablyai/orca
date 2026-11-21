import {
  providerDiagnostic,
  providerDiagnosticOf,
  withProviderDiagnostic
} from '../../../../shared/agent-session/failures/agent-session-failure'
import '../../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import { AgentSessionAcquisitionRefusal } from '../../../native-chat/agent-session-wire/providers/structured-agent-session-adapter-errors'
import { providerStartupFailureFact } from '../../../native-chat/agent-session-wire/startup/structured-agent-session-failure-text'
import { AgentSessionStartFailure } from '../../../native-chat/agent-session-wire/startup/structured-agent-session-start-failure'
import { redactString } from '../../../../shared/observability/redactor'
import type { ClaudeStructuredLaunch } from '../launch/claude-structured-launch-resolution'

const EXIT_STATUS = /^\((?:code|signal) [^)]*\)$/
/** Shorter arguments (`-p`, `on`) are too common to hide and too short to be secrets. */
const MIN_HIDDEN_ARGUMENT_CHARS = 4

/** A program may echo its arguments, which can be private (a profile, a token in no known shape). */
function withoutArguments(text: string, args: readonly string[] = []): string {
  const values = args.flatMap((arg) => [arg, arg.slice(arg.indexOf('=') + 1)])
  return values
    .filter((value) => value.length >= MIN_HIDDEN_ARGUMENT_CHARS)
    .sort((a, b) => b.length - a.length)
    .reduce((hidden, value) => hidden.replaceAll(value, '…'), text)
}

/** The first line the program wrote when it exited, else its exit status. */
function exitText(error: unknown): string {
  const lines = (providerDiagnosticOf(error)?.text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const written = lines.find((line) => !EXIT_STATUS.test(line))
  return written ? `: ${written}` : lines[0] ? ` ${lines[0]}` : ''
}

/** A start that exited under the user's Command setting names its program and what it said, so a
 *  Command that runs something else (`cc` is a compiler outside the user's shell) can be told apart
 *  from Claude failing. Never the Command's arguments: this text reaches agent mail and phone pushes;
 *  the original exit stays as the cause for local logs. */
export async function explainConfiguredCommandExit(
  error: unknown,
  launch: Pick<ClaudeStructuredLaunch, 'configuredProgram' | 'prefixArgs'> | undefined
): Promise<unknown> {
  // Claude's own answer, such as a missing conversation, explains the start better than its Command.
  const fact =
    error instanceof AgentSessionStartFailure ? error.fact : providerStartupFailureFact(error)
  if (!launch?.configuredProgram || fact.kind !== 'providerStartFailed') {
    return error
  }
  // Redact first: hiding an argument such as `--token` would hide the label that marks its value.
  const said = withoutArguments(redactString(exitText(error)), launch.prefixArgs)
  const words = `${redactString(`'${launch.configuredProgram}' exited`)}${said}`
  return withProviderDiagnostic(
    Object.assign(new AgentSessionAcquisitionRefusal(words, 'agentCommandNotRunnable'), {
      cause: error
    }),
    providerDiagnostic(words, 'person')
  )
}

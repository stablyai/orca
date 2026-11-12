import { getCommandTokenPathBasename } from '../../../shared/command-token-scanner'
import {
  quoteStartupArg,
  tokenizeStartupCommand,
  type AgentStartupShell
} from '../../../shared/agent-launch/startup/tui-agent-startup-shell'

const OPENCODE_EXECUTABLE = /^opencode2?(\.(exe|cmd))?$/i
const MODEL_FLAGS = ['--model', '-m']
const VALUE_FLAGS = ['--prompt', '--session', '-s']
// Flags the launch builders append unquoted; every other argument Orca emits is quoteStartupArg'd.
const BARE_FLAGS = new Set(['--prompt', '--standalone'])
const LITERAL_HEAD = /^[A-Za-z0-9._/\\:-]+$/
// Root options that leave a new session on the primary agent; resuming one makes the overlay moot.
const PROBE_NEUTRAL_FLAGS = new Set(['--auto', '--standalone'])
const LITERAL_MODEL = /^[A-Za-z0-9._/:@#+-]+$/

export type OpenCodeRootModelRewrite = {
  /** The command without its root model option, with `--standalone` so a private server reads the overlay. */
  command: string
  model: string
  /** The OpenCode executable token, set only when the remaining root options cannot change the primary agent. */
  probeExecutable?: string
}

/**
 * OpenCode 2's root TUI has no `--model`; its per-launch model is config read by a server this launch starts.
 * Only Orca's own emitted shape is rewritten: every argument quoted by quoteStartupArg or a known bare flag,
 * so no shell syntax can hide another command. Anything else stays exactly as typed.
 */
export function planOpenCodeRootModelRewrite(
  command: string,
  shell: AgentStartupShell,
  promptBody?: string
): OpenCodeRootModelRewrite | null {
  if (shell === 'cmd') {
    // cmd ends the line at a newline even inside quotes, and its quoting can split argv where it looks whole.
    const whole = tokenizeStartupCommand(command, shell)
    if (/[\r\n]/.test(command) || !whole.ok || whole.spans.some((span) => span.divergesFromShell)) {
      return null
    }
  }
  // The prompt operand is matched against the body Orca put in the env, never decoded.
  const promptSuffix =
    promptBody === undefined ? undefined : ` --prompt ${quoteStartupArg(promptBody, shell)}`
  const suffix = promptSuffix && command.endsWith(promptSuffix) ? promptSuffix : ''
  const prefix = command.slice(0, command.length - suffix.length)
  const parsed = tokenizeStartupCommand(prefix, shell)
  if (!parsed.ok || parsed.spans[0]?.start !== 0 || parsed.spans.at(-1)?.end !== prefix.length) {
    return null
  }
  const { tokens, spans } = parsed
  const raw = (index: number) => prefix.slice(spans[index].start, spans[index].end)
  const canonical = (index: number) =>
    !spans[index].divergesFromShell && raw(index) === quoteStartupArg(tokens[index], shell)
  const executable = shell === 'powershell' && raw(0) === '&' ? 1 : 0
  const head = tokens[executable] ?? ''
  if (
    spans.some(
      (span, index) => index > 0 && prefix.slice(spans[index - 1].end, span.start) !== ' '
    ) ||
    !OPENCODE_EXECUTABLE.test(getCommandTokenPathBasename(head)) ||
    !(canonical(executable) || (raw(executable) === head && LITERAL_HEAD.test(head))) ||
    tokens.some(
      (token, index) =>
        index > executable && !canonical(index) && !(raw(index) === token && BARE_FLAGS.has(token))
    )
  ) {
    return null
  }
  const removals: { start: number; end: number }[] = []
  let model: string | undefined
  let probeNeutral = true
  let standaloneOption = false
  for (let index = executable + 1; index < tokens.length; index += 1) {
    const token = tokens[index]
    // A positional (subcommand or directory) ends the root options; its own flags are not ours.
    if (token === '--' || !token.startsWith('-')) {
      return null
    }
    // Another server never reads this launch's config, so its model flag stays as typed.
    if (token === '--server' || token.startsWith('--server=')) {
      return null
    }
    const flag = MODEL_FLAGS.find((name) => token === name || token.startsWith(`${name}=`))
    if (flag) {
      const inline = token !== flag
      const valueIndex = inline ? index : index + 1
      const value = inline ? token.slice(flag.length + 1) : tokens[valueIndex]
      if (value === undefined || value.startsWith('-') || !LITERAL_MODEL.test(value)) {
        return null
      }
      model = value
      removals.push({ start: spans[index - 1].end, end: spans[valueIndex].end })
      index = valueIndex
      continue
    }
    standaloneOption ||= token === '--standalone'
    if (VALUE_FLAGS.includes(token)) {
      probeNeutral &&= token === '--prompt'
      index += 1
      continue
    }
    probeNeutral &&= PROBE_NEUTRAL_FLAGS.has(token) || token.startsWith('--prompt=')
  }
  if (!model) {
    return null
  }
  let stripped = prefix
  for (const removal of removals.toReversed()) {
    stripped = `${stripped.slice(0, removal.start)}${stripped.slice(removal.end)}`
  }
  const headEnd = spans[executable].end
  const standalone = standaloneOption
    ? stripped
    : `${stripped.slice(0, headEnd)} --standalone${stripped.slice(headEnd)}`
  return {
    command: `${standalone}${suffix}`,
    model,
    ...(probeNeutral ? { probeExecutable: head } : {})
  }
}

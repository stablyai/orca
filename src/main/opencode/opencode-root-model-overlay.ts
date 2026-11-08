import { getCommandTokenPathBasename } from '../../shared/command-token-scanner'
import {
  tokenizeStartupCommand,
  type AgentStartupShell
} from '../../shared/agent-launch/startup/tui-agent-startup-shell'
import { withOpenCodeStandaloneServer } from './opencode-private-server'

const OPENCODE_EXECUTABLE = /^opencode2?(\.(exe|cmd))?$/i
const MODEL_FLAGS = ['--model', '-m']
const VALUE_FLAGS = ['--prompt', '--session', '-s', '--server']
// Root options that leave a new session on the primary agent; resuming one makes the overlay moot.
const PROBE_NEUTRAL_FLAGS = new Set(['--auto', '--standalone'])
// Provider/model ids only; anything a shell could expand stays on the command line.
const LITERAL_MODEL = /^[A-Za-z0-9._/:@#+-]+$/

export type OpenCodeRootModelRewrite = {
  /** The command without its root model option, with `--standalone` so a private server reads the overlay. */
  command: string
  model: string
  /** The OpenCode executable token, set only when the remaining root options cannot change the primary agent. */
  probeExecutable?: string
}

/** OpenCode 2's root TUI has no `--model`; its per-launch model is config read by a server this launch starts. */
export function planOpenCodeRootModelRewrite(
  command: string,
  shell: AgentStartupShell
): OpenCodeRootModelRewrite | null {
  const parsed = tokenizeStartupCommand(command, shell)
  if (!parsed.ok) {
    return null
  }
  const { tokens, spans } = parsed
  const executable = shell === 'powershell' && tokens[0] === '&' ? 1 : 0
  if (!OPENCODE_EXECUTABLE.test(getCommandTokenPathBasename(tokens[executable] ?? ''))) {
    return null
  }
  const removals: { start: number; end: number }[] = []
  let model: string | undefined
  let probeNeutral = true
  for (let index = executable + 1; index < tokens.length; index += 1) {
    const token = tokens[index]
    // A positional (subcommand or directory) ends the root options; its own flags are not ours.
    if (token === '--' || !token.startsWith('-')) {
      return null
    }
    const flag = MODEL_FLAGS.find((name) => token === name || token.startsWith(`${name}=`))
    if (flag) {
      const inline = token !== flag
      const valueIndex = inline ? index : index + 1
      const value = inline ? token.slice(flag.length + 1) : tokens[valueIndex]
      const raw = spans[valueIndex]
        ? command.slice(spans[valueIndex].start, spans[valueIndex].end)
        : ''
      if (
        value === undefined ||
        value.startsWith('-') ||
        !LITERAL_MODEL.test(value) ||
        /[$%`]/.test(raw) ||
        spans[index].divergesFromShell ||
        spans[valueIndex].divergesFromShell
      ) {
        return null
      }
      model = value
      removals.push({ start: spans[index].start, end: spans[valueIndex].end })
      index = valueIndex
      continue
    }
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
  let stripped = command
  for (const removal of removals.toReversed()) {
    stripped = `${stripped.slice(0, removal.start).trimEnd()}${stripped.slice(removal.end)}`
  }
  const standalone = withOpenCodeStandaloneServer(stripped, shell)
  const reparsed = tokenizeStartupCommand(standalone, shell)
  // Without its own server the overlay never reaches the TUI, so the flag must stay.
  if (!reparsed.ok || !reparsed.tokens.includes('--standalone')) {
    return null
  }
  return {
    command: standalone,
    model,
    ...(probeNeutral ? { probeExecutable: tokens[executable] } : {})
  }
}

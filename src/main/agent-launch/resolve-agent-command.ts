// Launch command assembly: turn a launch decision plus its templates into the
// final structured argv (executable + user args), from the first untrusted byte
// to the last element. Custom overrides stay one executable element; legacy
// built-in prefixes tokenize per target shell; catalog argv is used verbatim.
// Target-shell quoting is deferred to the startup planner — this module never
// concatenates shell text.

import { posix as pathPosix, win32 as pathWin32 } from 'node:path'
import type { AgentArgv } from '../../shared/agent-launch-host-contract'
import type { AgentLaunchFailure } from '../../shared/agent-launch-contract'
import type { AgentStartupShell } from '../../shared/tui-agent-startup-shell'
import {
  CMD_UNENCODABLE_CHAR_RE,
  isShellExpandableExecutable,
  tokenizeStartupCommand
} from '../../shared/tui-agent-startup-shell'
import { getTuiAgentLaunchArgv, type TuiAgentConfig } from '../../shared/tui-agent-config'
import {
  canonicalizeCommandOverride,
  MAX_COMMAND_PATH_LENGTH
} from '../../shared/custom-tui-agent-fields'
import { tokenizeAgentArgsTemplate } from '../../shared/agent-args-tokenizer'
import { tokenizeLegacyAgentPrefix } from '../../shared/legacy-agent-prefix-tokenizer'
import {
  collectReferencedVariables,
  firstMissingVariable,
  interpolateVariables,
  LAUNCH_VARIABLE_ORDER,
  type LaunchVariableName,
  type LaunchVariableValues
} from './resolve-agent-variables'

// NUL, CR/LF, and the rest of C0/C1/DEL are never valid in a resolved executable.
// eslint-disable-next-line no-control-regex -- rejecting control chars is the point
const EXECUTABLE_CONTROL_RE = /[\0\r\n\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/

export type AssembleCommandInput = {
  config: TuiAgentConfig
  platform: NodeJS.Platform
  isRemote: boolean
  shell: AgentStartupShell
  targetHomePath: string | null
  /** Custom executable override (raw stored value); one argv element. */
  commandOverride?: string | null
  /** Legacy built-in command-prefix override (settings.agentCmdOverrides[base]). */
  prefixOverride?: string | null
  /** Args template; v1 grammar for custom, legacy grammar for built-in. */
  argsTemplate: string
  isCustomArgs: boolean
  /** Per-launch source-control recipe args (U7); v1 grammar, appended as a
   *  distinct band after the definition argv and before the prompt argv. */
  perLaunchArgs?: string
  /** Env values scanned so a variable referenced only in env is still required. */
  envValues: readonly string[]
  values: LaunchVariableValues
}

export type AssembleCommandResult =
  | {
      ok: true
      argv: AgentArgv
      prefixSource: 'catalog' | 'configured' | 'override'
      referenced: LaunchVariableName[]
    }
  | { ok: false; failure: AgentLaunchFailure }

type TildeResult = { ok: true; value: string } | { ok: false; failure: AgentLaunchFailure }

function expandTilde(arg: string, shell: AgentStartupShell, home: string | null): TildeResult {
  if (arg[0] !== '~') {
    return { ok: true, value: arg }
  }
  const second = arg[1]
  const isSep = second === undefined || second === '/' || (shell !== 'posix' && second === '\\')
  if (!isSep) {
    // ~user/ forms cannot be expanded without a passwd lookup; fail loudly
    // rather than emit a broken executable path.
    return {
      ok: false,
      failure: { code: 'invalid_command_override', field: 'commandOverride', reason: 'tilde_user' }
    }
  }
  if (home === null) {
    // No local view of the target's home (SSH/WSL/runtime). Defer to the shell
    // that owns it — aborting here also aborts worktree creation — but only for
    // a form the executable emitter leaves expandable.
    return isShellExpandableExecutable(arg, shell)
      ? { ok: true, value: arg }
      : { ok: false, failure: { code: 'missing_target_home' } }
  }
  const lib = shell === 'posix' ? pathPosix : pathWin32
  return { ok: true, value: arg === '~' ? home : lib.join(home, arg.slice(2)) }
}

function validateResolvedExecutable(value: string): AgentLaunchFailure | null {
  if (value.length === 0) {
    return { code: 'invalid_command_override', field: 'commandOverride', reason: 'empty' }
  }
  if (value.length > MAX_COMMAND_PATH_LENGTH) {
    return { code: 'invalid_command_override', field: 'commandOverride', reason: 'bounds' }
  }
  if (EXECUTABLE_CONTROL_RE.test(value)) {
    return { code: 'invalid_command_override', field: 'commandOverride', reason: 'control_char' }
  }
  return null
}

function tokenizeArgs(
  template: string,
  isCustom: boolean,
  shell: AgentStartupShell
): { ok: true; tokens: string[] } | { ok: false; failure: AgentLaunchFailure } {
  if (template.trim().length === 0) {
    return { ok: true, tokens: [] }
  }
  if (isCustom) {
    const result = tokenizeAgentArgsTemplate(template)
    if (!result.ok) {
      return {
        ok: false,
        failure: { code: 'invalid_agent_args', field: 'args', reason: result.reason, shell }
      }
    }
    return { ok: true, tokens: result.tokens }
  }
  // Built-in args use the shipped shell-aware grammar (#7862): posix keeps the
  // shared template grammar, Windows shells keep backslashes literal.
  const result = tokenizeStartupCommand(template.trim(), shell)
  if (!result.ok) {
    // Every shipped grammar only fails on an unclosed quote.
    return {
      ok: false,
      failure: { code: 'invalid_agent_args', field: 'args', reason: 'unterminated_quote', shell }
    }
  }
  return { ok: true, tokens: result.tokens }
}

function buildPrefix(
  input: AssembleCommandInput
):
  | { ok: true; argv: string[]; source: 'catalog' | 'configured' | 'override' }
  | { ok: false; failure: AgentLaunchFailure } {
  const { shell, targetHomePath } = input
  if (input.commandOverride !== undefined && input.commandOverride !== null) {
    const canonical = canonicalizeCommandOverride(input.commandOverride)
    const interpolated = interpolateVariables(canonical, input.values)
    if (shell === 'cmd' && CMD_UNENCODABLE_CHAR_RE.test(interpolated)) {
      return {
        ok: false,
        failure: {
          code: 'invalid_agent_args',
          field: 'commandOverride',
          reason: 'cmd_metachar',
          shell: 'cmd'
        }
      }
    }
    const expanded = expandTilde(interpolated, shell, targetHomePath)
    if (!expanded.ok) {
      return expanded
    }
    const invalid = validateResolvedExecutable(expanded.value)
    if (invalid) {
      return { ok: false, failure: invalid }
    }
    return { ok: true, argv: [expanded.value], source: 'override' }
  }

  if (input.prefixOverride && input.prefixOverride.trim().length > 0) {
    const tokenized = tokenizeLegacyAgentPrefix(input.prefixOverride, shell)
    if (!tokenized.ok) {
      return {
        ok: false,
        failure: {
          code: 'invalid_command_override',
          field: 'commandOverride',
          reason: tokenized.reason,
          shell
        }
      }
    }
    // The legacy prefix tokenizer only rejects `& | ; < >` + control chars, so on
    // cmd a `%NAME%`/`!DELAYED!`/`^`/`"` in a prefix token would reach the writer
    // and trigger cmd expansion — fail closed like every other cmd-quoted band.
    if (shell === 'cmd') {
      for (const token of tokenized.tokens) {
        if (CMD_UNENCODABLE_CHAR_RE.test(token)) {
          return {
            ok: false,
            failure: {
              code: 'invalid_agent_args',
              field: 'commandOverride',
              reason: 'cmd_metachar',
              shell: 'cmd'
            }
          }
        }
      }
    }
    if (tokenized.tokens.length > 0) {
      const expanded = expandTilde(tokenized.tokens[0], shell, targetHomePath)
      if (!expanded.ok) {
        return expanded
      }
      return {
        ok: true,
        argv: [expanded.value, ...tokenized.tokens.slice(1)],
        source: 'configured'
      }
    }
  }

  const catalogArgv = getTuiAgentLaunchArgv(input.config, input.platform, {
    isRemote: input.isRemote
  })
  const expanded = expandTilde(catalogArgv[0], shell, targetHomePath)
  if (!expanded.ok) {
    return expanded
  }
  return { ok: true, argv: [expanded.value, ...catalogArgv.slice(1)], source: 'catalog' }
}

/** Assemble the final structured argv, or return the first typed failure. Runs
 *  the missing-variable scan across command/args/env before any interpolation. */
export function assembleCommand(input: AssembleCommandInput): AssembleCommandResult {
  const args = tokenizeArgs(input.argsTemplate, input.isCustomArgs, input.shell)
  if (!args.ok) {
    return args
  }

  // Recipe args are a per-launch band validated through the SAME v1 (custom)
  // grammar as definition custom args, so they surface the identical
  // invalid_agent_args diagnostics and count against the same command/env caps.
  const recipeArgs = tokenizeArgs(input.perLaunchArgs ?? '', true, input.shell)
  if (!recipeArgs.ok) {
    return recipeArgs
  }

  const argvScanTexts = [
    ...(input.commandOverride ? [canonicalizeCommandOverride(input.commandOverride)] : []),
    ...args.tokens,
    ...recipeArgs.tokens
  ]
  // Env values are required if they reference a variable, so they count toward the
  // missing-variable scan; but they are delivered in the process environment block
  // (not the cmd command line), so they are excluded from the cmd-metachar guard.
  const referenced = collectReferencedVariables([...argvScanTexts, ...input.envValues])
  const argvReferenced = collectReferencedVariables(argvScanTexts)
  const missing = firstMissingVariable(referenced, input.values)
  if (missing) {
    return { ok: false, failure: { code: 'missing_variable', variable: missing } }
  }

  // A variable value carrying a cmd-unencodable char that reaches the cmd command
  // line fails closed before any writer runs. Env-only references are exempt: the
  // environment block encodes %/!/^/" faithfully, unlike the double-quoted argv.
  if (input.shell === 'cmd') {
    for (const name of LAUNCH_VARIABLE_ORDER) {
      const value = input.values[name]
      if (argvReferenced.has(name) && value && CMD_UNENCODABLE_CHAR_RE.test(value)) {
        return {
          ok: false,
          failure: { code: 'invalid_agent_args', reason: 'cmd_metachar', shell: 'cmd' }
        }
      }
    }
  }

  const prefix = buildPrefix(input)
  if (!prefix.ok) {
    return prefix
  }

  const argTokens = args.tokens.map((token) => interpolateVariables(token, input.values))
  const recipeArgTokens = recipeArgs.tokens.map((token) =>
    interpolateVariables(token, input.values)
  )
  // Every user-configurable args band fails closed on cmd: built-in
  // agentDefaultArgs can carry %/! just like custom or recipe args, and the cmd
  // quoter cannot encode them faithfully inside a double-quoted element.
  const cmdSensitiveTokens = [...argTokens, ...recipeArgTokens]
  if (input.shell === 'cmd') {
    for (const token of cmdSensitiveTokens) {
      if (CMD_UNENCODABLE_CHAR_RE.test(token)) {
        return {
          ok: false,
          failure: {
            code: 'invalid_agent_args',
            field: 'args',
            reason: 'cmd_metachar',
            shell: 'cmd'
          }
        }
      }
    }
  }

  return {
    ok: true,
    argv: [prefix.argv[0], ...prefix.argv.slice(1), ...argTokens, ...recipeArgTokens] as AgentArgv,
    prefixSource: prefix.source,
    referenced: LAUNCH_VARIABLE_ORDER.filter((name) => referenced.has(name))
  }
}

#!/usr/bin/env node
import {
  findCommandSpec,
  isCommandGroup,
  normalizeCommandPositionals,
  parseArgs,
  resolveHelpPath,
  specPaths,
  validateCommandAndFlags
} from './args'
import { dispatch } from './dispatch'
import { reportCliError } from './format'
import { printHelp } from './help'
import { RuntimeClient } from './runtime-client'
import { COMMAND_SPECS } from './specs'

export { COMMAND_SPECS } from './specs'
export { buildCurrentWorktreeSelector, normalizeWorktreeSelector } from './selectors'

const COMMAND_PATHS = COMMAND_SPECS.flatMap((spec) => specPaths(spec))

function shouldIgnoreRemoteSelection(commandPath: string[]): boolean {
  return (
    commandPath[0] === 'environment' ||
    // Why: bare `serve` starts a local runtime, so remote selection is moot and
    // must be ignored. But `serve stats` queries a (possibly remote) runtime and
    // MUST honor --environment/ORCA_ENVIRONMENT — narrow this guard to exactly
    // `['serve']` so the stats subcommand keeps its remote selection.
    (commandPath[0] === 'serve' && commandPath.length === 1) ||
    commandPath[0] === 'agent' ||
    commandPath[0] === 'vm' ||
    commandPath[0] === 'agent-context'
  )
}

// Why: the SSH relay bridge executes this CLI on the Orca host while the
// caller's shell cwd lives on the remote machine (which cannot be chdir'd
// into). ORCA_CLI_CWD carries that remote cwd so cwd-based selectors like
// `--worktree active` resolve against the caller's directory.
function resolveInvocationCwd(): string {
  const override = process.env.ORCA_CLI_CWD
  return typeof override === 'string' && override.length > 0 ? override : process.cwd()
}

export async function main(
  argv = process.argv.slice(2),
  cwd = resolveInvocationCwd()
): Promise<void> {
  if (argv[0] === 'agent-teams-tmux') {
    await runAgentTeamsTmuxShim(argv.slice(1))
    return
  }
  if (argv[0] === 'claude-teams') {
    await runClaudeTeams(argv.slice(1), cwd)
    return
  }
  const parsed = normalizeCommandPositionals(COMMAND_SPECS, parseArgs(argv, COMMAND_PATHS))
  const helpPath = resolveHelpPath(parsed)
  if (helpPath !== null) {
    printHelp(COMMAND_SPECS, helpPath)
    if (
      helpPath.length > 0 &&
      !findCommandSpec(COMMAND_SPECS, helpPath) &&
      !isCommandGroup(helpPath)
    ) {
      process.exitCode = 1
    }
    return
  }
  if (parsed.commandPath.length === 0) {
    printHelp(COMMAND_SPECS, [])
    return
  }
  const json = parsed.flags.has('json')

  try {
    // Why: CLI syntax and flag errors should be reported before any runtime
    // lookup so users do not get misleading "Orca is not running" failures for
    // simple command typos or unsupported flags.
    validateCommandAndFlags(COMMAND_SPECS, parsed)
    const ignoreRemoteSelection = shouldIgnoreRemoteSelection(parsed.commandPath)
    const pairingCode = ignoreRemoteSelection ? null : parsed.flags.get('pairing-code')
    const environmentSelector = ignoreRemoteSelection ? null : parsed.flags.get('environment')
    // Why: pass `null` (not `undefined`) when remote selection is suppressed
    // so the RuntimeClient default parameter does not re-activate the
    // ORCA_PAIRING_CODE / ORCA_ENVIRONMENT env-var fallback for commands
    // that must run locally (environment / serve).
    let client: RuntimeClient | undefined
    await dispatch(parsed.commandPath, {
      flags: parsed.flags,
      // Why: local-only handlers must not resolve runtime metadata just to dispatch.
      get client() {
        client ??= new RuntimeClient(
          undefined,
          undefined,
          typeof pairingCode === 'string' ? pairingCode : ignoreRemoteSelection ? null : undefined,
          typeof environmentSelector === 'string'
            ? environmentSelector
            : ignoreRemoteSelection
              ? null
              : undefined
        )
        return client
      },
      cwd,
      json
    })
  } catch (error) {
    reportCliError(error, json, { commandPath: parsed.commandPath })
    process.exitCode = 1
  }
}

async function runClaudeTeams(argv: string[], cwd: string): Promise<void> {
  try {
    // Why: everything after `orca claude-teams` belongs to Claude Code, not
    // Orca's own flag parser, so new Claude flags work without Orca changes.
    const client = new RuntimeClient(undefined, undefined, null, null)
    await dispatch(['claude-teams'], {
      flags: new Map(),
      client,
      cwd,
      json: false,
      rawArgs: argv
    })
  } catch (error) {
    reportCliError(error, false, { commandPath: ['claude-teams'] })
    process.exitCode = 1
  }
}

async function runAgentTeamsTmuxShim(argv: string[]): Promise<void> {
  try {
    const client = new RuntimeClient(undefined, 10_000)
    const response = await client.call<{
      tmux: { stdout: string; stderr: string; exitCode: number }
    }>(
      'agentTeams.tmuxCompat',
      {
        teamId: process.env.ORCA_AGENT_TEAMS_TEAM_ID,
        token: process.env.ORCA_AGENT_TEAMS_TOKEN,
        envPane: process.env.TMUX_PANE,
        cwd: process.cwd(),
        argv
      },
      { timeoutMs: 10_000 }
    )
    process.stdout.write(response.result.tmux.stdout)
    process.stderr.write(response.result.tmux.stderr)
    process.exitCode = response.result.tmux.exitCode
  } catch (error) {
    reportCliError(error, false, { commandPath: ['agent-teams-tmux'] })
    process.exitCode = 1
  }
}

if (require.main === module) {
  void main()
}

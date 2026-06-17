import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { resolveClaudeAgentTeamsShimBin } from '../runtime/claude-agent-teams-shim-env'
import { quoteStartupArg, type AgentStartupShell } from '../../shared/tui-agent-startup'

// Injects the Orca-managed Matrix MCP server into a Claude launch when the
// Matrix adapter is enabled. The config is written to ~/.orca (NOT the
// worktree) and passed via Claude's `--mcp-config <file>` flag. The MCP server
// (`orca matrix-mcp`) self-scopes via inherited env (ORCA_PANE_KEY +
// agent-hooks loopback coordinates), so the config carries no per-session env.

const MCP_SERVER_NAME = 'orca-matrix'
const MCP_CONFIG_RELATIVE_DIR = ['.orca', 'mcp']
const MCP_CONFIG_FILENAME = 'orca-matrix.json'

function mcpConfigDir(): string {
  return join(homedir(), ...MCP_CONFIG_RELATIVE_DIR)
}

function mcpConfigPath(): string {
  return join(mcpConfigDir(), MCP_CONFIG_FILENAME)
}

// The MCP server inherits env, so the config only needs command + args. Linux
// ships the CLI as `orca-ide`, so resolve the platform binary rather than
// hardcoding `orca`.
function buildMcpConfigJson(env: Record<string, string | undefined>): string {
  const command = resolveClaudeAgentTeamsShimBin(env)
  const config = {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        command,
        args: ['matrix-mcp']
      }
    }
  }
  return `${JSON.stringify(config, null, 2)}\n`
}

// Writes the managed config only when its content changed, so we don't churn
// the file on every launch. Returns the path the caller passes to --mcp-config.
function ensureMcpConfigFile(env: Record<string, string | undefined>): string {
  const path = mcpConfigPath()
  const next = buildMcpConfigJson(env)
  try {
    if (readFileSync(path, { encoding: 'utf-8' }) === next) {
      return path
    }
  } catch {
    // Missing/unreadable — (re)write below.
  }
  mkdirSync(mcpConfigDir(), { recursive: true })
  writeFileSync(path, next, { encoding: 'utf-8', mode: 0o600 })
  return path
}

// The single gate for Matrix MCP injection: a Claude launch with the adapter
// enabled and a real command string. When this returns false the caller must
// leave the launch command and env byte-identical to a non-Matrix launch.
export function shouldInjectMatrixMcp(args: {
  isClaudeLaunch: boolean
  matrixEnabled: boolean
  command: string | undefined
}): args is { isClaudeLaunch: true; matrixEnabled: true; command: string } {
  return args.isClaudeLaunch && args.matrixEnabled && typeof args.command === 'string'
}

export type MatrixMcpInjection = {
  command: string
  env: Record<string, string>
}

// Why an appended system prompt and not just tool descriptions: tool
// availability does not make a model USE a tool. This puts the awareness — that
// it is in an Orca session, that a human is reachable, and WHEN to ask rather
// than guess — directly in the system prompt so usage is reliable, not incidental.
const ORCA_SESSION_SYSTEM_PROMPT =
  'You are running inside an Orca session. A human operator is reachable in real ' +
  'time over Matrix via the orca-matrix MCP tools. Prefer asking over guessing: ' +
  'when you hit a decision, approval, missing detail, or ambiguity you would ' +
  'otherwise assume your way through, call orca_ask_operator with one specific ' +
  'question and wait for the answer instead of proceeding on an assumption. Use ' +
  'orca_send_message to proactively report significant progress, blockers, or ' +
  'completion. Call orca_session_info if you need the reply handle or room. These ' +
  'tools exist only inside this Orca session.'

// Returns the Claude command with `--mcp-config <path>` and an Orca-session
// `--append-system-prompt` appended, plus the ORCA_SESSION_ACTIVE env marker.
// Call ONLY when the launch is Claude and the Matrix adapter is enabled;
// otherwise the launch command/env are unchanged.
export function injectMatrixMcpIntoClaudeLaunch(args: {
  command: string
  shell: AgentStartupShell
  spawnEnv: Record<string, string | undefined>
}): MatrixMcpInjection {
  const path = ensureMcpConfigFile(args.spawnEnv)
  const quotedPath = quoteStartupArg(path, args.shell)
  const quotedPrompt = quoteStartupArg(ORCA_SESSION_SYSTEM_PROMPT, args.shell)
  return {
    command: `${args.command} --mcp-config ${quotedPath} --append-system-prompt ${quotedPrompt}`,
    // ORCA_SESSION_ACTIVE makes the agent aware it is in an Orca session so it
    // only uses the relay tools then.
    env: { ORCA_SESSION_ACTIVE: 'true' }
  }
}

export { MCP_SERVER_NAME }

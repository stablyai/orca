// Talks to orcad inside a running VM through the `orca` CLI that orcad itself installs at
// $ORCA_USER_DATA/cli/bin/orca (same user, local socket, no pairing). The command line is fixed;
// user text only ever travels as a separate argv entry, never through a shell.
import { z } from 'zod'
import type { SandboxProviderApi } from '../sandbox-provider'

export const PROJECT_ROOT = '/vercel/sandbox/project'
export const AGENTS = ['claude', 'codex'] as const
export type AgentId = (typeof AGENTS)[number]

/**
 * `sh -c SCRIPT orca ARGS...`: the script references "$@" only, so ARGS are data. The prelude
 * registers the project with orcad (idempotent) because a workspace made through the API never had
 * a desktop add it, and marks Claude Code's first-run screens done so a prompt is not stuck behind
 * them (theme picker, folder trust). It never touches credentials.
 */
const ORCA_SCRIPT = String.raw`set -eu
O="$HOME/.orcad-data/cli/bin/orca"
P=${PROJECT_ROOT}
if [ ! -x "$O" ]; then echo '{"ok":false,"error":{"code":"orca_cli_missing"}}'; exit 0; fi
cd "$P" 2>/dev/null || cd "$HOME"
if [ "$1" = "--prepare" ]; then
  shift
  [ -d "$P/.git" ] || { git -C "$P" init -q && git -C "$P" -c user.name=Orca -c user.email=cloud@onorca.dev commit -q --allow-empty -m init; } >/dev/null 2>&1 || true
  "$O" repo add --path "$P" --json >/dev/null 2>&1 || true
  C="$HOME/.claude.json"
  if command -v jq >/dev/null 2>&1; then
    [ -s "$C" ] || echo '{}' >"$C"
    jq --arg p "$P" '.hasCompletedOnboarding = true | .theme = (.theme // "dark") | .bypassPermissionsModeAccepted = true | .projects[$p].hasTrustDialogAccepted = true | .projects[$p].hasCompletedProjectOnboarding = true' "$C" >"$C.tmp" && mv "$C.tmp" "$C"
    # Orca launches agents in this sandboxed VM with permissions bypassed; its one-time warning would
    # otherwise swallow the prompt (its default answer is "No, exit").
    S="$HOME/.claude/settings.json"
    mkdir -p "$HOME/.claude"
    [ -s "$S" ] || echo '{}' >"$S"
    jq '.skipDangerousModePermissionPrompt = true' "$S" >"$S.tmp" && mv "$S.tmp" "$S"
  fi
fi
exec "$O" "$@" --json`

export class VmAgentError extends Error {
  constructor(
    readonly code: string,
    readonly detail?: string
  ) {
    super(detail ? `${code}: ${detail}` : code)
    this.name = 'VmAgentError'
  }
}

const Envelope = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.object({ code: z.string(), message: z.string().optional() }).loose().optional()
}).loose()

async function orca(provider: SandboxProviderApi, sessionId: string, args: string[], options: { prepare?: boolean; timeoutMs?: number } = {}) {
  const result = await provider.runCommand(sessionId, {
    command: '/bin/sh',
    args: ['-c', ORCA_SCRIPT, 'orca', ...(options.prepare ? ['--prepare'] : []), ...args],
    timeoutMs: options.timeoutMs ?? 60_000
  })
  // The CLI prints one JSON document; take the outermost object so stray warnings do not break parsing.
  const start = result.stdout.indexOf('{')
  const end = result.stdout.lastIndexOf('}')
  let parsed: z.infer<typeof Envelope>
  try {
    parsed = Envelope.parse(JSON.parse(result.stdout.slice(start, end + 1)))
  } catch {
    throw new VmAgentError('orca_cli_invalid_output', `exit ${result.exitCode}`)
  }
  if (!parsed.ok) {
    throw new VmAgentError(parsed.error?.code ?? 'orca_cli_failed', parsed.error?.message?.slice(0, 200))
  }
  return parsed.result
}

const LaunchResult = z.object({ outcome: z.object({ kind: z.string(), handle: z.string().optional() }).loose() }).loose()

/** Starts a new agent session with `prompt` in the workspace; returns its terminal handle. */
export async function launchAgent(provider: SandboxProviderApi, sessionId: string, agent: AgentId, prompt: string): Promise<string> {
  const result = LaunchResult.safeParse(
    await orca(provider, sessionId, ['agent', 'launch', '--agent', agent, '--worktree', `path:${PROJECT_ROOT}`, '--surface', 'terminal', '--prompt', prompt], {
      prepare: true,
      timeoutMs: 90_000
    })
  )
  const handle = result.success ? result.data.outcome.handle : undefined
  if (!handle) {
    throw new VmAgentError('agent_launch_failed')
  }
  return handle
}

/** Types `text` into a running agent session and submits it. */
export async function sendToSession(provider: SandboxProviderApi, sessionId: string, handle: string, text: string): Promise<void> {
  await orca(provider, sessionId, ['terminal', 'send', '--terminal', handle, '--text', text, '--enter'], { timeoutMs: 60_000 })
}

const TerminalList = z.object({
  terminals: z.array(
    z.object({
      handle: z.string(),
      title: z.string().optional(),
      connected: z.boolean().optional(),
      lastOutputAt: z.number().nullable().optional(),
      preview: z.string().optional(),
      agentIdentity: z.string().nullable().optional(),
      worktreePath: z.string().optional()
    }).loose()
  )
}).loose()

export type AgentSession = {
  handle: string
  agent: string | null
  title: string | null
  connected: boolean
  lastOutputAt: number | null
  preview: string | null
}

export async function listSessions(provider: SandboxProviderApi, sessionId: string): Promise<AgentSession[]> {
  const parsed = TerminalList.safeParse(await orca(provider, sessionId, ['terminal', 'list', '--limit', '100']))
  if (!parsed.success) {
    throw new VmAgentError('orca_cli_invalid_output')
  }
  return parsed.data.terminals.map((t) => ({
    handle: t.handle,
    agent: t.agentIdentity ?? null,
    title: t.title ?? null,
    connected: t.connected ?? false,
    lastOutputAt: t.lastOutputAt ?? null,
    // The last few lines only: enough to see what the agent is doing, not a transcript export.
    preview: t.preview ? t.preview.split('\n').slice(-6).join('\n').slice(0, 1200) : null
  }))
}

/**
 * Writes the workspace-scoped API token where the in-VM `orca` CLI looks for it. The value goes
 * through the command env (never argv, never logged); the file is 0600 and revoked server-side at
 * the next boot, suspend or destroy, so a stale copy in a snapshot is useless.
 */
export async function installWorkspaceToken(
  provider: SandboxProviderApi,
  sessionId: string,
  token: { secret: string; apiUrl: string; workspaceId: string } | null
): Promise<void> {
  const script = String.raw`set -e
umask 077
D="$HOME/.config/orca-cloud"
mkdir -p "$D"
if [ -z "$ORCA_CLOUD_TOKEN_VALUE" ]; then rm -f "$D/credentials.json"; exit 0; fi
printf '{"apiUrl":"%s","token":"%s","workspaceId":"%s"}\n' "$ORCA_CLOUD_API_URL_VALUE" "$ORCA_CLOUD_TOKEN_VALUE" "$ORCA_CLOUD_WORKSPACE_VALUE" >"$D/credentials.json.tmp"
mv "$D/credentials.json.tmp" "$D/credentials.json"`
  const result = await provider.runCommand(sessionId, {
    command: '/bin/sh',
    args: ['-c', script],
    env: token
      ? { ORCA_CLOUD_TOKEN_VALUE: token.secret, ORCA_CLOUD_API_URL_VALUE: token.apiUrl, ORCA_CLOUD_WORKSPACE_VALUE: token.workspaceId }
      : {},
    timeoutMs: 20_000
  })
  if (result.exitCode !== 0) {
    throw new VmAgentError('token_install_failed')
  }
}

const TerminalRead = z.object({ terminal: z.object({ handle: z.string(), status: z.string().optional(), tail: z.array(z.string()) }).loose() }).loose()

/** The rendered screen of one agent session (what a person would see), trailing blank lines dropped. */
export async function readSession(provider: SandboxProviderApi, sessionId: string, handle: string): Promise<{ status: string | null; screen: string }> {
  const parsed = TerminalRead.safeParse(await orca(provider, sessionId, ['terminal', 'read', '--terminal', handle, '--screen']))
  if (!parsed.success) {
    throw new VmAgentError('orca_cli_invalid_output')
  }
  const lines = parsed.data.terminal.tail.map((line) => line.trimEnd())
  while (lines.length > 0 && lines.at(-1) === '') {
    lines.pop()
  }
  return { status: parsed.data.terminal.status ?? null, screen: lines.join('\n').slice(-16_000) }
}

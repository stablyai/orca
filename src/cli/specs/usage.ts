import { GLOBAL_FLAGS, type CommandSpec } from '../args'

// Why: agents (e.g. a matriarch orchestrator) need to read remaining provider
// quota before handing out work. The whole fetch/parse pipeline already exists
// behind `accounts.list`; this command exposes its RateLimitState to the CLI.
export const USAGE_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['usage'],
    summary:
      'Show remaining AI provider usage/quota (Claude, Codex, Gemini, ...) on this Orca host',
    usage: 'orca usage [provider] [--refresh] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'refresh', 'provider'],
    positionalArgs: ['provider'],
    notes: [
      "Reports each provider's 5-hour and weekly windows (percent used and reset time) for the active managed account.",
      'Optional provider filter: claude, codex, gemini, opencode-go, kimi, minimax, grok, antigravity.',
      'Returns the last-known (cached) numbers by default; pass --refresh to force a live provider fetch (one round-trip per active account, and can be rate-limited).',
      'Honors --environment to query a paired remote host; that host reports its own accounts and usage.'
    ],
    examples: ['orca usage', 'orca usage claude --json', 'orca usage codex --refresh']
  }
]

import { GLOBAL_FLAGS, type CommandSpec } from '../args'

export const RESOURCE_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['resource', 'status'],
    summary: 'Print identity-free provider usage/rate-limit evidence as machine-readable JSON',
    usage: 'orca resource status [--json] [--refresh]',
    allowedFlags: [...GLOBAL_FLAGS, 'refresh'],
    notes: [
      'Read-only projection of the same rate-limit state the status bar renders: per-provider windows with a remaining ratio (0.01-grained), reset time, source_updated_at and data_age_ms. It never includes account identity, credentials, or raw provider payloads.',
      'Each window carries a stable scope (session, weekly, fableWeekly, monthly, bucket) that identifies the underlying quota; role (BURST/BUDGET/UNKNOWN) is only the generic capacity horizon. Do not rely on array order.',
      'Returns the cached poll snapshot by default. --refresh runs the existing stale-aware provider fetch first (the poll throttle and Retry-After still apply); it does not force a fetch on every call.',
      'reset_at_source is always "unknown": the underlying state does not record whether a reset time came from the provider directly or was derived.'
    ],
    examples: ['orca resource status --json', 'orca resource status --json --refresh']
  }
]

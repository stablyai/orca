// §571 env cleaning for opaque legacy replay. A pre-U5 sleeping record may have
// captured a Claude Agent Teams launch env whose team identity, tmux/TERM state,
// pairing keys, and shim-prefixed PATH were minted per-launch. Replaying those
// verbatim would re-inject a stale team token/shim; the downstream launch path
// regenerates a fresh team plan, so the durable replay config must drop the
// generated keys while preserving a safely separable user PATH tail.
//
// This is deliberately NOT an extension of the shared `stripEphemeralAgentTeamsEnv`
// (claude-agent-teams-service.ts): that function also cleans the FRESH-launch
// durable snapshot (orca-runtime), where a user's own custom TERM/PATH must be
// preserved. Stripping TERM/PATH there would regress custom env. The legacy
// cleaning only engages for a CAPTURED team config and removes the shim PATH
// prefix surgically (proven by the captured shim-dir), so it is safe to apply
// only on the legacy replay path.

import { isPosixStartupShell, type AgentStartupShell } from '../../shared/tui-agent-startup-shell'

// Generated keys removed only when the config is a captured team launch. TMUX /
// TMUX_PANE are ephemeral for every launch and stripped unconditionally below.
const GENERATED_TEAM_ONLY_KEYS = new Set([
  'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS',
  'TERM',
  'COLORTERM'
])

// Presence of any of these proves the captured env came from an Agent Teams
// launch; only then do the team-only strips and PATH-shim removal engage.
const TEAM_MARKER_KEY_PREFIX = 'ORCA_AGENT_TEAMS_'
const TEAM_MARKER_KEYS = ['CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS']

export function isCapturedAgentTeamsConfig(env: Record<string, string>): boolean {
  return Object.keys(env).some(
    (key) => key.startsWith(TEAM_MARKER_KEY_PREFIX) || TEAM_MARKER_KEYS.includes(key)
  )
}

/** `:` for the sh family, `;` for the Windows shells. fish has no member of its
 *  own — AgentStartupShell folds every Unix shell into 'posix' — so it must be
 *  routed through the shared predicate, not matched as a separate literal. */
export function pathDelimiterForShell(shell: AgentStartupShell): string {
  return isPosixStartupShell(shell) ? ':' : ';'
}

/** Remove Orca attribution + (for captured team configs) generated team/auth/
 *  TMUX/TERM/pairing keys and the proven shim PATH prefix. Non-team configs keep
 *  their PATH and TERM untouched. Fails safe on an unprovable shim by dropping the
 *  whole PATH entry rather than replaying a possibly shim-poisoned one. */
export function stripLegacyReplayEnv(
  env: Record<string, string>,
  shell: AgentStartupShell
): Record<string, string> {
  const isTeam = isCapturedAgentTeamsConfig(env)
  const shimDir = env.ORCA_AGENT_TEAMS_SHIM_DIR?.trim() || null
  const delimiter = pathDelimiterForShell(shell)
  // Windows env keys are case-insensitive, so a Windows-captured `Path`/`Term`
  // must be matched case-folded — an exact-case check lets the shim-poisoned
  // `Path` skip the strip and replay verbatim (poisoning fails in the unsafe dir).
  const isWindowsShell = shell === 'cmd' || shell === 'powershell'
  const generatedTeamOnlyLower = new Set(
    [...GENERATED_TEAM_ONLY_KEYS].map((generatedKey) => generatedKey.toLowerCase())
  )
  const matchesGeneratedTeamOnly = (key: string, lower: string): boolean =>
    isWindowsShell ? generatedTeamOnlyLower.has(lower) : GENERATED_TEAM_ONLY_KEYS.has(key)
  // Null prototype: an own '__proto__' key (JSON/IPC can produce one) must
  // survive as data so validateCustomAgentEnv rejects it downstream, instead of
  // being silently swallowed by the Object.prototype.__proto__ setter.
  const cleaned: Record<string, string> = Object.create(null) as Record<string, string>
  for (const [key, value] of Object.entries(env)) {
    const lower = key.toLowerCase()
    // Orca attribution (pane/hook/token, team ids, pairing, environment) plus the
    // tmux pane handle are always regenerated and must never replay.
    if (lower.startsWith('orca_') || key === 'TMUX' || key === 'TMUX_PANE') {
      continue
    }
    if (isTeam && matchesGeneratedTeamOnly(key, lower)) {
      continue
    }
    if (isTeam && (key === 'PATH' || (isWindowsShell && lower === 'path'))) {
      const tail = resolveUserPathTail(value, shimDir, delimiter)
      if (tail) {
        cleaned.PATH = tail
      }
      continue
    }
    cleaned[key] = value
  }
  return cleaned
}

/** Return the user PATH tail after removing the proven shim prefix, or null when
 *  the shim cannot be proven (drop the ambiguous PATH rather than guess). The
 *  shim dir is prepended as the FIRST segment by createLaunchEnv. */
function resolveUserPathTail(
  pathValue: string,
  shimDir: string | null,
  delimiter: string
): string | null {
  if (!shimDir) {
    return null
  }
  const segments = pathValue.split(delimiter)
  if (segments[0] !== shimDir) {
    return null
  }
  const tail = segments.slice(1).filter(Boolean)
  return tail.length > 0 ? tail.join(delimiter) : null
}

import type { ProviderRelayKeepSpec } from '../../daemon/protocol/daemon-provider-relay-protocol'
import type { RelayedProviderChild } from '../../provider-relay/relayed-provider-child'
import { readClaudeReportedPermissionMode } from '../structured/startup/claude-structured-init-proof'

/** Claude's own word on its mode: its init, and the status line it writes for each mode change
 *  (the CLI writes these keys first and in this order). */
const INIT = '{"type":"system","subtype":"init"'
const MODE_REPORT = '{"type":"system","subtype":"status","status":null,"permissionMode":"'

/** The daemon keeps the latest of each, so a reattach knows the mode Claude last confirmed. */
export const CLAUDE_RELAY_KEEP: ProviderRelayKeepSpec = {
  answers: [],
  lines: [INIT, MODE_REPORT],
  outstanding: []
}

/** The note a relay launched with no permission flag carries: Claude runs the user's own settings. */
const OWN_SETTINGS_NOTE = 'own-settings'

/** The keep spec for a launch's arguments, noting a launch that left the mode to Claude's settings. */
export function claudeRelayKeepFor(args: readonly string[]): ProviderRelayKeepSpec {
  const flagged = args.some(
    (arg) =>
      arg === '--dangerously-skip-permissions' ||
      arg === '--permission-mode' ||
      arg.startsWith('--permission-mode=')
  )
  return flagged ? CLAUDE_RELAY_KEEP : { ...CLAUDE_RELAY_KEEP, note: OWN_SETTINGS_NOTE }
}

export type ClaudeKeptMode = {
  /** Claude's last reported mode as the daemon kept it, when it kept one. */
  confirmedMode: string | null | undefined
  /** Launched on the user's own settings and still in the mode its init reported from them. */
  ownSettings: boolean
}

/** Hands the kept mode lines to `observe` in the order Claude wrote them, once; a relay spawned
 *  without the keep spec has none, so Claude's mode stays unknown until it reports. */
export function feedClaudeKeptModeLines(
  child: RelayedProviderChild,
  observe: ((chunk: string) => void) | undefined
): ClaudeKeptMode {
  const names = new Set(CLAUDE_RELAY_KEEP.lines.map((marker) => `l:${marker}`))
  const lines = (child.attachResult?.kept ?? [])
    .filter(({ name }) => names.has(name))
    .sort((a, b) => a.seq - b.seq)
    .flatMap(({ seq }) => {
      const line = child.kept.lines.get(seq)
      return line === undefined ? [] : [line]
    })
  child.kept.drop()
  let confirmed: string | null | undefined
  let launched: string | null | undefined
  for (const line of lines) {
    observe?.(`${line}\n`)
    const mode = readKeptMode(line)
    if (mode !== undefined && line.startsWith(INIT)) {
      launched = mode
    }
    confirmed = mode ?? confirmed
  }
  const ownLaunch = child.attachResult?.launchNote === OWN_SETTINGS_NOTE
  return {
    confirmedMode: confirmed,
    ownSettings: ownLaunch && launched != null && confirmed === launched
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readKeptMode(line: string): string | null | undefined {
  try {
    const frame: unknown = JSON.parse(line)
    return isRecord(frame) ? readClaudeReportedPermissionMode(frame) : undefined
  } catch {
    return undefined
  }
}

import type { ProviderRelayKeepSpec } from '../../daemon/protocol/daemon-provider-relay-protocol'
import type { RelayedProviderChild } from '../../provider-relay/relayed-provider-child'

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

/** Hands the kept mode lines to `observe` in the order Claude wrote them, once; a relay spawned
 *  without the keep spec has none, so Claude's mode stays unknown until it reports. */
export function feedClaudeKeptModeLines(
  child: RelayedProviderChild,
  observe: ((chunk: string) => void) | undefined
): void {
  const names = new Set(CLAUDE_RELAY_KEEP.lines.map((marker) => `l:${marker}`))
  const lines = (child.attachResult?.kept ?? [])
    .filter(({ name }) => names.has(name))
    .sort((a, b) => a.seq - b.seq)
    .flatMap(({ seq }) => {
      const line = child.kept.keptLines.get(seq)
      return line === undefined ? [] : [line]
    })
  child.kept.dropKeptLines()
  for (const line of lines) {
    observe?.(`${line}\n`)
  }
}

import { parsePaneKey } from '../../../../shared/stable-pane-id'

// Leaf UUIDs survive pane break-out; exact match also supports legacy/unparseable keys.
export function isEquivalentPaneKey(a: string, b: string): boolean {
  if (a === b) {
    return true
  }
  const aLeaf = parsePaneKey(a)?.leafId
  const bLeaf = parsePaneKey(b)?.leafId
  return Boolean(aLeaf && bLeaf && aLeaf === bLeaf)
}

export function parseWorkerTerminalPriorOwnerIds(value: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) && parsed.every((entry) => typeof entry === 'string')
      ? parsed
      : null
  } catch {
    return null
  }
}

// An indexable suffix prefilter narrows candidates; isEquivalentPaneKey still decides equivalence.
export const RUN_PANE_KEY_MATCH_SUFFIX_SQL =
  "substr(coordinator_pane_key, instr(coordinator_pane_key, ':') + 1)"
export const DISPATCH_PANE_KEY_MATCH_SUFFIX_SQL =
  "substr(assignee_pane_key, instr(assignee_pane_key, ':') + 1)"
export const REMOTE_ATTACHMENT_PANE_KEY_MATCH_SUFFIX_SQL =
  "substr(pane_key, instr(pane_key, ':') + 1)"

export function paneKeyMatchSuffix(paneKey: string): string {
  const colon = paneKey.indexOf(':')
  return colon === -1 ? paneKey : paneKey.slice(colon + 1)
}

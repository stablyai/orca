// OpenClaw keeps one transcript subtree per agent: <stateDir>/agents/<agent>/sessions/**.
// Shared by the local and remote scanners so every host lists the tree the
// same way. Walker depth counts from the `agents` root: a predicate sees the
// entry's depth (agent dir = 0), a notice sees the listed dir's (agent dir = 1).
const OPENCLAW_SESSIONS_DIR_NAME = 'sessions'
// OpenClaw's own runtime state (auth profiles, models, embedded tool homes).
const OPENCLAW_RUNTIME_DIR_NAME = 'agent'

/** Keep every agent directory, then descend only into its `sessions` subtree. */
export function isOpenClawSessionDirectory(name: string, depth: number): boolean {
  return depth !== 1 || name === OPENCLAW_SESSIONS_DIR_NAME
}

/**
 * An agent directory with no `sessions` child but other content (a relocated
 * archive, loose JSONL) is pruned without being walked, so say so instead of
 * letting its rows vanish silently. The runtime dir alone is a fresh agent.
 */
export function openClawPrunedAgentNotice(
  depth: number,
  directoryNames: readonly string[],
  fileNames: readonly string[]
): string | null {
  if (depth !== 1 || directoryNames.includes(OPENCLAW_SESSIONS_DIR_NAME)) {
    return null
  }
  const holdsCandidates =
    directoryNames.some((name) => name !== OPENCLAW_RUNTIME_DIR_NAME) ||
    fileNames.some((name) => name.toLowerCase().endsWith('.jsonl'))
  return holdsCandidates
    ? 'No sessions directory found; OpenClaw transcripts outside <agent>/sessions are not scanned.'
    : null
}

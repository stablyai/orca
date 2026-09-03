// Machine-readable Spotlight status at <root>/.orca/spotlight-state.json.
// Agents read it (path derivable from $ORCA_SPOTLIGHT_LOG's directory) to know
// whether THEIR workspace currently holds the Spotlight before treating server
// log errors as their own.
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import type { SpotlightRepoState } from '../../shared/spotlight'
import { SPOTLIGHT_STATE_RELATIVE_PATH } from '../../shared/spotlight'
import { getWorktreePathBasenameFromId, splitWorktreeId } from '../../shared/worktree/id'
import { writeFileAtomically } from '../codex-accounts/fs-utils'

export async function writeSpotlightStateFile(
  rootPath: string,
  state: SpotlightRepoState | null
): Promise<void> {
  try {
    const filePath = path.join(rootPath, ...SPOTLIGHT_STATE_RELATIVE_PATH.split('/'))
    await mkdir(path.dirname(filePath), { recursive: true })
    const payload = state
      ? {
          active: true,
          holderWorkspace: getWorktreePathBasenameFromId(state.holderWorktreeId),
          holderWorktreePath: splitWorktreeId(state.holderWorktreeId)?.worktreePath ?? null,
          activatedAt: new Date(state.activatedAt).toISOString(),
          lastSyncAt: state.lastSyncAt ? new Date(state.lastSyncAt).toISOString() : null,
          snapshotSha: state.lastSnapshotSha,
          lastError: state.lastError
        }
      : { active: false, updatedAt: new Date().toISOString() }
    // Atomic (tmp + rename): agents in other worktrees read this file
    // concurrently, so a plain write could expose truncated/partial JSON.
    writeFileAtomically(filePath, `${JSON.stringify(payload, null, 2)}\n`)
  } catch {
    // Best-effort: the state file is advisory for agents; never block an op on it.
  }
}

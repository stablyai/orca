import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const WORKTREE_INVENTORY_COMMAND_SPEC: CommandSpec = {
  path: ['worktree', 'inventory'],
  summary: 'Read a complete local Git and Orca registration inventory, including hidden worktrees',
  usage:
    'orca worktree inventory --repo id:<repo-id> --repo-path <path> --project <id> --host local [--json]',
  allowedFlags: [...GLOBAL_FLAGS, 'repo', 'repo-path', 'project', 'host'],
  notes: [
    'Read-only: does not import, migrate or prune records or change visibility. Existing list/ps behavior is unchanged.',
    'Require authoritative=true, truncated=false, matching scope and empty failureReasons before using absence. totalCount counts Git rows plus registration records, not unique checkouts.',
    'Includes legacy and canonical metadata, every identity alias, and relevant lineage, even without a Git checkout. Unattributable records prevent authority.',
    'Local native Git only. SSH, paired runtime, WSL and folder targets are refused explicitly without local fallback. Limits and cursors are not supported.',
    'A point-in-time inventory is not a lock or proof of disk, Git ref or terminal absence. Older runtimes return method_not_found; never fall back to list/ps.'
  ]
}

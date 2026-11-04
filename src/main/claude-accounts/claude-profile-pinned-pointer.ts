import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  CLAUDE_INJECTED_CONFIG_DIR_ENV,
  CLAUDE_PROFILE_POINTER_ENV,
  CLAUDE_USER_CONFIG_DIR_ENV
} from '../../shared/claude-profile-routing'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import type { ClaudeEnvPatch } from './environment'
import { readUserClaudeConfigDirAsSet } from './claude-profile-paths'

/** A pointer per account beside the selection's own: the shell function re-reads it on every
 *  `claude`, so a pinned pane relaunches on its account. An empty home is System default. */
export function writePinnedClaudePointer(
  selectedPointer: string,
  accountId: string | null,
  home: string,
  env: NodeJS.ProcessEnv
): ClaudeEnvPatch {
  const userConfigDir = readUserClaudeConfigDirAsSet(env)
  const pointer = join(dirname(selectedPointer), 'pinned', accountId ?? 'system')
  mkdirSync(dirname(pointer), { recursive: true, mode: 0o700 })
  writeFileAtomically(pointer, home, { mode: 0o600 })
  return {
    [CLAUDE_PROFILE_POINTER_ENV]: pointer,
    // Lets the shell function tell the user's rc value from Orca's, as for the selected pointer.
    ...(userConfigDir ? { [CLAUDE_USER_CONFIG_DIR_ENV]: userConfigDir } : {}),
    ...(home ? { CLAUDE_CONFIG_DIR: home, [CLAUDE_INJECTED_CONFIG_DIR_ENV]: home } : {})
  }
}

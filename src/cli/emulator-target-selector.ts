import type { RuntimeClient } from './runtime-client'
import { RuntimeClientError } from './runtime/types'
import { getOptionalStringFlag } from './flags'
import { assertLocalCwdWorktreeSelector, resolveCurrentWorktreeSelector } from './selectors'

// Match browser targeting: workspace by default, explicit device/emulator/worktree overrides.
export type EmulatorCliTarget = {
  worktree?: string
  device?: string
  emulator?: string // Orca id from list
}

export async function getEmulatorWorktreeSelector(
  flags: Map<string, string | boolean>,
  cwd: string,
  client: RuntimeClient
): Promise<string | undefined> {
  const explicit = getOptionalStringFlag(flags, 'worktree')
  if (explicit === 'all') {
    return undefined
  }
  if (explicit) {
    if (explicit === 'active' || explicit === 'current') {
      assertLocalCwdWorktreeSelector(explicit, client)
      return resolveCurrentWorktreeSelector(cwd, client)
    }
    return explicit
  }
  if (client.isRemote) {
    return undefined
  }
  const terminalWorktreeId = process.env.ORCA_WORKTREE_ID
  if (terminalWorktreeId?.trim()) {
    return terminalWorktreeId
  }
  const folderWorkspaceId = process.env.ORCA_WORKSPACE_ID?.trim()
  if (folderWorkspaceId?.startsWith('folder:')) {
    return folderWorkspaceId
  }
  try {
    return await resolveCurrentWorktreeSelector(cwd, client)
  } catch (error) {
    // Why: a same-path worktree on another relay host must not be replaced with
    // an unscoped request, while an unmanaged cwd preserves server-side focus.
    if (!(error instanceof RuntimeClientError) || error.code !== 'selector_not_found') {
      throw error
    }
    return undefined
  }
}

export async function getEmulatorCommandTarget(
  flags: Map<string, string | boolean>,
  cwd: string,
  client: RuntimeClient
): Promise<EmulatorCliTarget> {
  const device = getOptionalStringFlag(flags, 'device')
  const emulator = getOptionalStringFlag(flags, 'emulator')
  const worktree = await getEmulatorWorktreeSelector(flags, cwd, client)
  if (device || emulator) {
    return { device: device || undefined, emulator: emulator || undefined, worktree }
  }
  return { worktree }
}

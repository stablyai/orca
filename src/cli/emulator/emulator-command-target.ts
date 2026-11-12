import type { RuntimeClient } from '../runtime/client'
import { RuntimeClientError } from '../runtime/types'
import { assertLocalCwdWorktreeSelector } from '../hosts/local-environment-selector'
import { getOptionalStringFlag } from '../flags'
import {
  resolveCallerPaneWorktreeSelector,
  type WorkspaceSelectionPurpose
} from '../workspace-selection/caller-host-worktree-selection'
import { resolveCurrentWorktreeSelector } from '../workspace-selection/workspace-selector'

export type EmulatorCliTarget = {
  worktree?: string
  device?: string
  emulator?: string // Orca id from list
}

async function optionalCurrentWorktreeSelector(
  cwd: string,
  client: RuntimeClient,
  purpose: WorkspaceSelectionPurpose = 'worktree'
) {
  try {
    return await resolveCurrentWorktreeSelector(cwd, client, purpose)
  } catch (error) {
    if (error instanceof RuntimeClientError && error.code === 'selector_ambiguous') {
      throw error
    }
    return undefined
  }
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
    const scoped = await resolveCallerPaneWorktreeSelector(terminalWorktreeId, client)
    if (scoped) {
      return scoped
    }
  }
  const folderWorkspaceId = process.env.ORCA_WORKSPACE_ID?.trim()
  if (folderWorkspaceId?.startsWith('folder:')) {
    return folderWorkspaceId
  }
  return optionalCurrentWorktreeSelector(cwd, client)
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
    return {
      device: device || undefined,
      emulator: emulator || undefined,
      worktree
    }
  }
  return { worktree }
}

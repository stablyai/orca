import { stat } from 'node:fs/promises'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { AgentSessionAcquisitionRefusal } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { AgentSessionRecordStore } from './agent-session-record-store'
import { agentSessionPinnedLaunchDirectory } from './agent-session-record-workspace-path'

/** The floating folder a session ran in is gone; resuming anywhere else would be a different chat. */
export class AgentSessionWorkspaceMissingError extends AgentSessionAcquisitionRefusal {
  constructor(readonly workspacePath: string) {
    super(
      `The folder this chat ran in no longer exists: ${workspacePath}. Restore it to continue.`,
      'agent_session_operation_invalid'
    )
    this.name = 'AgentSessionWorkspaceMissingError'
  }
}

export type AgentSessionLaunchDirectoryDeps = {
  store: Pick<AgentSessionRecordStore, 'pinWorkspacePath'>
  /** Absolute path of a workspace on this host, by the workspace's current directory policy. */
  resolveWorkspacePath: (workspaceId: string) => Promise<string>
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch (error) {
    // Only absence means the folder is gone; a permission or I/O failure is reported as itself.
    if (isDefinitiveAbsence(error)) {
      return false
    }
    throw error
  }
}

/**
 * The one answer to "which directory does this acquisition launch the provider in".
 *
 * The floating workspace id names a setting, not a place, so a floating session resumes in the
 * folder it was pinned to and refuses when that folder is gone. Worktree and folder ids name a
 * durable place and keep resolving by id. A record not yet pinned — a new session, or one written
 * before the pin existed — is pinned here with the directory this launch uses; a failed pin write
 * is logged and the launch proceeds.
 */
export async function resolveAgentSessionLaunchDirectory(
  deps: AgentSessionLaunchDirectoryDeps,
  record: AgentSessionRecord
): Promise<string> {
  const pinned = agentSessionPinnedLaunchDirectory(record)
  if (pinned !== undefined) {
    if (!(await isDirectory(pinned))) {
      throw new AgentSessionWorkspaceMissingError(pinned)
    }
    return pinned
  }
  const resolved = await deps.resolveWorkspacePath(record.location.workspaceId)
  if (record.workspacePath === undefined) {
    try {
      await deps.store.pinWorkspacePath(record.sessionId, resolved)
    } catch (error) {
      // Bookkeeping must not gate the launch; an unpinned record is pinned by its next launch.
      console.warn('[agent-session] launch directory pin failed', record.sessionId, error)
    }
  }
  return resolved
}

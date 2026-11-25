import {
  claudeAccountBindingForWorkspace,
  type ClaudeWorkspaceBindingLookup
} from '../../../shared/agent-accounts/claude/claude-workspace-account-binding'
import type { ClaudeAccountBinding } from '../../../shared/agent-accounts/claude/claude-account-binding'

let installed: ClaudeWorkspaceBindingLookup | undefined

/** Installed only in the process that owns the project catalog. */
export function installClaudeWorkspaceBindingLookup(
  lookup: ClaudeWorkspaceBindingLookup | undefined
): void {
  installed = lookup
}

export function installedClaudeAccountBinding(
  workspaceId: string | undefined
): ClaudeAccountBinding | null {
  return claudeAccountBindingForWorkspace(workspaceId, installed)
}

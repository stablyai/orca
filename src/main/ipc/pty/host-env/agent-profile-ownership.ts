// Register a committed process before fallible UI/persistence work can release its pending lease.
import { isAbsolute, sep } from 'node:path'
import type { PtySpawnResult } from '../../../providers/types'
import type { PreparedAgentProfile } from '../../../agent-profiles/connection-service'
import {
  markClaudePtySpawned,
  reserveClaudeCredentialOwner
} from '../../../claude-accounts/live-pty-gate'
import { ClaudeRuntimePathResolver } from '../../../claude-accounts/runtime-paths'
import { validateExternalProfileHome } from '../../../agent-profile-discovery/existing-home'
import { recordCodexPaneAccount } from '../../../codex/codex-pane-account-registry'
export type PreparedTerminalAgentProfile = PreparedAgentProfile & {
  claudeCredentialIsolation?: boolean
}

export async function reserveAgentProfilePtyOwnership(
  prepared: PreparedAgentProfile
): Promise<PreparedTerminalAgentProfile> {
  if (prepared.snapshot.agent !== 'claude') {
    return prepared
  }
  if (prepared.snapshot.binding.kind === 'managed') {
    return { ...prepared, claudeCredentialIsolation: true }
  }
  const configDir = new ClaudeRuntimePathResolver().getRuntimePaths().configDir
  // Canonicalization must follow symlinks before interpreting parent segments.
  const absoluteConfigDir = isAbsolute(configDir) ? configDir : `${process.cwd()}${sep}${configDir}`
  const runtimeHome = await validateExternalProfileHome(absoluteConfigDir)
  if (!runtimeHome.ok || runtimeHome.home !== prepared.snapshot.resolvedHome) {
    return prepared
  }
  // Home identity grants a refresh lease, never permission to inspect external credentials.
  const release = reserveClaudeCredentialOwner(false, { deferRuntimeRefresh: true })
  return {
    ...prepared,
    claudeCredentialIsolation: false,
    release: () => {
      try {
        prepared.release()
      } finally {
        release()
      }
    }
  }
}

export function commitAgentProfilePtyOwnership(
  prepared: PreparedTerminalAgentProfile | undefined,
  result: Pick<
    PtySpawnResult,
    'id' | 'isReattach' | 'exitedBeforeSpawnReply' | 'agentSessionEnsure'
  >
): void {
  if (
    !prepared ||
    result.isReattach ||
    result.exitedBeforeSpawnReply ||
    result.agentSessionEnsure?.disposition === 'adopted'
  ) {
    return
  }
  const snapshot = prepared.snapshot
  if (snapshot.agent === 'claude') {
    if (prepared.claudeCredentialIsolation !== undefined) {
      markClaudePtySpawned(result.id, prepared.claudeCredentialIsolation)
    }
  } else {
    recordCodexPaneAccount(result.id, {
      selectionKey: 'host',
      accountId: snapshot.binding.kind === 'managed' ? snapshot.binding.accountId : null,
      homeRoute: snapshot.binding.kind === 'managed' ? 'account-home' : 'external-profile-home',
      profileBound: true
    })
  }
}

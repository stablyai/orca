import type { ProviderAccountRef } from '../../shared/provider-account-ref'
import type { TuiAgent } from '../../shared/types'
import { parseWslUncPath } from '../../shared/wsl-paths'

export function assertProviderAccountRefForWorkspace(args: {
  agent: TuiAgent
  providerAccountRef?: ProviderAccountRef
  workspace: { path: string; connectionId: string | null }
}): void {
  const { agent, providerAccountRef, workspace } = args
  if (!providerAccountRef) {
    return
  }
  if (agent !== 'codex' || providerAccountRef.provider !== 'codex') {
    throw new Error('agent_session_account_agent_mismatch')
  }
  if (workspace.connectionId) {
    // Why: an account ref belongs to this Orca runtime, not an SSH
    // downstream whose credential registry this process cannot attest.
    throw new Error('agent_session_account_runtime_mismatch')
  }
  const wsl = parseWslUncPath(workspace.path)
  if ((providerAccountRef.runtime === 'wsl') !== Boolean(wsl)) {
    throw new Error('agent_session_account_runtime_mismatch')
  }
  if (
    wsl &&
    providerAccountRef.wslDistro?.trim() &&
    providerAccountRef.wslDistro.trim().toLocaleLowerCase('en-US') !==
      wsl.distro.toLocaleLowerCase('en-US')
  ) {
    throw new Error('agent_session_account_runtime_mismatch')
  }
}

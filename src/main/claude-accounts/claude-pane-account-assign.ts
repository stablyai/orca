import { getClaudeProfileRouter } from './claude-profile-installed-router'
import {
  bindClaudeAuthProxyAccountDir,
  getClaudeAuthProxy
} from './claude-auth-proxy/claude-auth-proxy-host'
import { assignClaudePaneAccount, getClaudePaneAccount } from './claude-pane-account-registry'

export type AssignClaudePaneRequest = {
  ptyId: string
  accountId: string
  configDir?: string
}

/** The account folder whose credential file the proxy re-reads for this pane. */
function configDirForAssignedAccount(
  accountId: string,
  explicit: string | undefined
): string | null {
  const router = getClaudeProfileRouter()
  if (!router) {
    return explicit ?? null
  }
  try {
    const covered = router.coveredBySystemDefault(accountId)
    const userDir = router.userConfigDir()
    const resolved = covered
      ? (userDir ?? router.systemDefaultHome())
      : router.accountHome(accountId)
    return resolved || explicit || null
  } catch {
    return explicit ?? null
  }
}

/**
 * Point a live pane's proxy slot at another account. Missing panes return assigned: false.
 * A WSL guest has no profile router, so the caller supplies that account's configDir.
 */
export function assignClaudePaneOnExecutionHost(request: AssignClaudePaneRequest): {
  assigned: boolean
} {
  const record = getClaudePaneAccount(request.ptyId)
  if (!record?.proxySlot) {
    return { assigned: false }
  }
  const configDir = configDirForAssignedAccount(request.accountId, request.configDir)
  if (!configDir) {
    return { assigned: false }
  }
  bindClaudeAuthProxyAccountDir(request.accountId, configDir)
  const proxy = getClaudeAuthProxy()
  if (!proxy?.assignSlot(record.proxySlot, request.accountId)) {
    return { assigned: false }
  }
  return { assigned: assignClaudePaneAccount(request.ptyId, request.accountId) }
}

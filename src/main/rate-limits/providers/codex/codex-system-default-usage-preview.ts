import type { CodexSystemDefaultIdentity } from '../../../../shared/agent-accounts/managed-account-types'
import { codexSystemDefaultUsageKey } from '../../../../shared/agent-accounts/codex/codex-system-default-usage'
import type { InactiveCodexAccountInfo } from '../../service/service-types'

export function codexSystemDefaultUsagePreview(
  hostAccountId: string | null,
  identity: CodexSystemDefaultIdentity,
  home: string
): InactiveCodexAccountInfo | null {
  const id = codexSystemDefaultUsageKey(identity)
  return hostAccountId && id
    ? { id, resolveHome: () => ({ kind: 'ready', managedHomePath: home }) }
    : null
}

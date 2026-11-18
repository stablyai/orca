import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readCodexAuthIdentity } from '../../../codex-accounts/credentials/codex-auth-identity'
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
    ? {
        id,
        resolveHome: async () => {
          const authSnapshot = await readFile(join(home, 'auth.json'), 'utf8').catch(() => null)
          if (!authSnapshot) {
            return { kind: 'skip' }
          }
          const actual = readCodexAuthIdentity(authSnapshot)
          if (
            !actual ||
            actual.email !== identity.email ||
            actual.providerAccountId !== identity.providerAccountId
          ) {
            return { kind: 'skip' }
          }
          return { kind: 'ready', managedHomePath: home, authSnapshot }
        }
      }
    : null
}

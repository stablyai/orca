import type { IPtyProvider } from '../providers/pty-provider-contract'
import { parseAppSshPtyId } from '../providers/ssh-pty-id'
import { ptyOwnership } from '../ipc/pty/provider/ownership-state'
import { getLocalPtyProvider, tryGetProviderForPty } from '../ipc/pty/provider/registry'
import { resolveOmpPaneSessionIdentity } from '../native-chat/omp-terminal-session-identity'
import { hasOtherOmpLocalPtySessionWriter } from './omp-rpc-local-pty-session-writer-proof'

export function localOmpRpcPtyProvider(ptyId: string): IPtyProvider | null {
  const connectionId = ptyOwnership.get(ptyId)
  const parsedSshId = connectionId === undefined ? parseAppSshPtyId(ptyId) : null
  if (connectionId || parsedSshId) {
    return null
  }
  return tryGetProviderForPty(ptyId) ?? null
}

export function isLocalOmpRpcPtyAlive(ptyId: string): boolean | null {
  const provider = localOmpRpcPtyProvider(ptyId)
  if (!provider?.hasPty) {
    return null
  }
  try {
    return provider.hasPty(ptyId)
  } catch {
    return null
  }
}

export async function localOmpRpcPtySlavePath(ptyId: string): Promise<string | undefined> {
  try {
    return await localOmpRpcPtyProvider(ptyId)?.getSlavePath?.(ptyId)
  } catch {
    return undefined
  }
}

export async function hasOtherLocalOmpRpcPtySessionWriter(
  sessionFilePath: string,
  excludedPtyId: string
): Promise<boolean> {
  return hasOtherOmpLocalPtySessionWriter({
    sessionFilePath,
    excludedPtyId,
    provider: getLocalPtyProvider(),
    resolveSessionIdentity: async ({ ptyId, cwd }) => {
      // POSIX needs a terminal breadcrumb; Windows ConPTYs only have the
      // session-file fallback, which must fence a possible competing writer.
      if (process.platform !== 'win32' && !(await localOmpRpcPtySlavePath(ptyId))) {
        return null
      }
      return resolveOmpPaneSessionIdentity(
        { ptyId, cwd },
        { getSlavePath: localOmpRpcPtySlavePath }
      )
    }
  })
}

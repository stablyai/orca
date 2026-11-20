import type { RuntimeStore } from '../construction/runtime-store-contract'
import {
  toWindowsWslPath,
  toWindowsWslDrivePath,
  toLinuxPath
} from '../../../shared/file-access/wsl-paths'
import { fitAgentImagePath } from '../../native-chat/agent-images/agent-image-fit-client'
import { isAgentInlineImagePath } from '../../../shared/native-chat/input/composer/agent-inline-image-types'
import { guardWslUncPathAccess } from '../../wsl/filesystem/wsl-unc-access-gate'
import { resolveLocalFileRequestPath } from '../../ipc/filesystem/access/local-file-access-resolution'

export async function prepareAgentImagePathsOnHost(
  paths: readonly string[],
  store: RuntimeStore,
  signal?: AbortSignal,
  wslDistro?: string
): Promise<string[]> {
  const prepared: string[] = []
  for (const path of paths) {
    signal?.throwIfAborted()
    if (!isAgentInlineImagePath(path)) {
      prepared.push(path)
      continue
    }
    const readable =
      process.platform === 'win32' && path.startsWith('/') && !path.startsWith('//')
        ? (toWindowsWslDrivePath(path) ?? (wslDistro ? toWindowsWslPath(path, wslDistro) : path))
        : path
    const authorized = await guardWslUncPathAccess(readable, () =>
      resolveLocalFileRequestPath(readable, { kind: 'chat-image' }, store)
    ).catch(() => null)
    if (!authorized) {
      prepared.push(path)
      continue
    }
    const fitted = await fitAgentImagePath(authorized, signal)
    prepared.push(fitted === authorized ? path : readable !== path ? toLinuxPath(fitted) : fitted)
  }
  return prepared
}

// Seams between the Orca Cloud offline service and the rest of main: the keychain codec, the
// window call observer, and the Sleep/archive hooks. No service state lives here.
import { assessSecretProtection } from '../host/electron-secret-store'
import { guardedSafeStorage } from '../host/safe-storage-availability'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import { OFFLINE_READ_METHODS, type OfflineCacheCodec } from './cloud-offline-cache-types'
import type { CloudMessageQueue } from './cloud-message-queue'

/** The OS keychain seals the cache and queue; without it nothing reaches disk. */
export function safeStorageCodec(): OfflineCacheCodec | null {
  try {
    // Linux basic_text "seals" with a built-in key: treat it as no keychain at all.
    if (!guardedSafeStorage.isEncryptionAvailable() || assessSecretProtection().level !== 'os') {
      return null
    }
  } catch {
    return null
  }
  return {
    encrypt: (plain) => guardedSafeStorage.encryptString(plain),
    decrypt: (sealed) => guardedSafeStorage.decryptString(sealed)
  }
}

let observer:
  | ((
      environmentId: string,
      method: string,
      params: unknown,
      response: RuntimeRpcResponse<unknown>
    ) => void)
  | null = null

/** The window's call seam: keep allowlisted answers from Orca Cloud VMs. Never alters the answer. */
export function observeCloudOfflineAnswer(
  environmentId: string,
  method: string,
  params: unknown,
  response: RuntimeRpcResponse<unknown>
): RuntimeRpcResponse<unknown> {
  if (observer && response.ok && OFFLINE_READ_METHODS.has(method)) {
    try {
      observer(environmentId, method, params, response)
    } catch (error) {
      // Caching is best effort; the window gets its answer either way.
      console.error(`[orca-cloud] offline cache record failed: ${String(error)}`)
    }
  }
  return response
}

export function setCloudOfflineObserver(next: typeof observer): void {
  observer = next
}

type CaptureService = { capture(workspaceId: string): Promise<void>; queue: CloudMessageQueue }
let current: CaptureService | null = null
export function setCloudOfflineService(next: CaptureService | null): void {
  current = next
}

/** Before a Sleep: snapshot every Orca Cloud workspace among `workspaceIds` (no-op otherwise). */
export async function captureCloudWorkspacesBeforeSleep(
  workspaceIds: readonly string[]
): Promise<void> {
  const service = current
  if (!service) {
    return
  }
  await Promise.all(workspaceIds.map((id) => service.capture(id).catch(() => undefined)))
}

/** After a Sleep or archive: prompts still waiting fail rather than wake the VM later. */
export function failQueuedCloudPrompts(workspaceIds: readonly string[], reason: string): void {
  for (const id of workspaceIds) {
    current?.queue.failPending(id, reason)
  }
}

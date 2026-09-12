import type { IPtyProvider } from '../providers/types'
import {
  getSshPtyProvider,
  sshProvidersByGeneration,
  unregisterSshPtyProviderIfCurrent
} from '../ipc/pty/provider/registry'
import {
  getSshFilesystemProvider,
  unregisterSshFilesystemProviderIfCurrent
} from '../providers/ssh-filesystem-dispatch'
import {
  getSshGitProvider,
  getSshGitProviderGeneration,
  unregisterSshGitProviderIfCurrent
} from '../providers/ssh-git-dispatch'

export function captureSshResetProviderRetirement(targetId: string, providerGeneration: number) {
  const provider = getSshPtyProvider(targetId)
  const filesystem = getSshFilesystemProvider(targetId)
  const git = getSshGitProvider(targetId)
  const gitGeneration = getSshGitProviderGeneration(targetId)
  let removed = false
  let ptyDisposed = false
  let filesystemDisposed = false
  const refuse = (): never => {
    throw new Error('SSH reset captured providers changed')
  }
  if (!provider || !filesystem || !git) {
    refuse()
  }
  const capturedProvider = provider as IPtyProvider
  function assertCurrent(): void {
    if (
      getSshPtyProvider(targetId) !== (removed ? undefined : provider) ||
      sshProvidersByGeneration.get(providerGeneration) !== (removed ? undefined : provider) ||
      (!removed &&
        (provider as { providerGeneration?: number }).providerGeneration !== providerGeneration) ||
      getSshFilesystemProvider(targetId) !== (removed ? undefined : filesystem) ||
      getSshGitProvider(targetId) !== (removed ? undefined : git) ||
      getSshGitProviderGeneration(targetId) !== gitGeneration + (removed ? 1 : 0)
    ) {
      refuse()
    }
  }
  assertCurrent()
  return {
    provider: capturedProvider,
    providerGeneration,
    assertCurrent,
    retire(assertAuthority: () => void): void {
      assertAuthority()
      assertCurrent()
      if (!removed) {
        // Remove the whole captured registry cohort before disposal can invoke callbacks.
        if (!unregisterSshPtyProviderIfCurrent(targetId, capturedProvider, providerGeneration)) {
          refuse()
        }
        if (!unregisterSshFilesystemProviderIfCurrent(targetId, filesystem!)) {
          refuse()
        }
        if (!unregisterSshGitProviderIfCurrent(targetId, git!, gitGeneration)) {
          refuse()
        }
        removed = true
      }
      if (!ptyDisposed) {
        ;(capturedProvider as IPtyProvider & { dispose?: () => void }).dispose?.()
        ptyDisposed = true
      }
      assertAuthority()
      assertCurrent()
      if (!filesystemDisposed) {
        ;(filesystem as typeof filesystem & { dispose?: () => void }).dispose?.()
        filesystemDisposed = true
      }
      assertAuthority()
      assertCurrent()
    },
    assertRetired(): void {
      assertCurrent()
      if (!removed || !ptyDisposed || !filesystemDisposed) {
        throw new Error('SSH reset captured providers are not retired')
      }
    }
  }
}

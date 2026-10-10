/**
 * The git, filesystem and terminal providers for one SSH host, registered and removed as a unit
 * so the host's routes can never disagree about whether it is connected.
 */
import { getSshPtyProvider, registerSshPtyProvider, unregisterSshPtyProvider } from '../ipc/pty'
import {
  getSshFilesystemProvider,
  registerSshFilesystemProvider,
  unregisterSshFilesystemProvider
} from '../providers/ssh-filesystem-dispatch'
import { registerSshGitProvider, unregisterSshGitProvider } from '../providers/ssh-git-dispatch'
import type { SshGitProvider } from '../providers/ssh-git-provider'
import type { IFilesystemProvider, IPtyProvider } from '../providers/types'

export type SshHostProviderSet = {
  pty: IPtyProvider
  fs: IFilesystemProvider
  /** `null`: no Orca runtime on the host (plain SSH), so git is unsupported, not unreachable. */
  git: SshGitProvider | null
}

/** Replaces every provider for the host; a set without git also clears any earlier git provider. */
export function registerSshHostProviders(targetId: string, providers: SshHostProviderSet): void {
  registerSshPtyProvider(targetId, providers.pty)
  registerSshFilesystemProvider(targetId, providers.fs)
  if (providers.git) {
    registerSshGitProvider(targetId, providers.git)
  } else {
    unregisterSshGitProvider(targetId)
  }
}

/**
 * Disposes and removes the host's providers. With `owned`, the caller's own providers are
 * disposed, and the host is cleared only if that set is still the registered one.
 */
export function retireSshHostProviders(
  targetId: string,
  owned?: Pick<SshHostProviderSet, 'pty' | 'fs'>
): void {
  for (const provider of [
    owned?.pty ?? getSshPtyProvider(targetId),
    owned?.fs ?? getSshFilesystemProvider(targetId)
  ]) {
    if (provider && 'dispose' in provider && typeof provider.dispose === 'function') {
      provider.dispose()
    }
  }
  if (owned && getSshPtyProvider(targetId) !== owned.pty) {
    return
  }
  unregisterSshPtyProvider(targetId)
  unregisterSshFilesystemProvider(targetId)
  unregisterSshGitProvider(targetId)
}

import type { WslHookRelayManagerDeps } from './wsl-hook-relay-deps'
import { createWslHookSftpAdapter } from './wsl-hook-fs-adapter'
import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'

const MANAGED_HOOK_CLEANUP_TIMEOUT_MS = 2_000

export type WslHookRelayDisposableState = {
  distro: string
  mux?: SshChannelMultiplexer
  guestHome?: string
  child?: { kill: () => unknown }
}

export async function disposeWslHookRelayState(
  deps: Pick<WslHookRelayManagerDeps, 'removeHooks' | 'warn'>,
  state: WslHookRelayDisposableState
): Promise<void> {
  try {
    const mux = state.mux
    if (!mux || !state.guestHome || mux.isDisposed()) {
      return
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        deps.removeHooks(createWslHookSftpAdapter(mux), state.guestHome, {
          agents: ['grok']
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('managed hook cleanup timed out')),
            MANAGED_HOOK_CLEANUP_TIMEOUT_MS
          )
          timer.unref?.()
        })
      ])
    } catch (error) {
      deps.warn(
        `[agent-hooks] WSL hook cleanup for '${state.distro}' failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    } finally {
      clearTimeout(timer)
    }
  } finally {
    state.mux?.dispose()
    state.child?.kill()
  }
}

/**
 * Registers the plain SSH providers for a target whose runtime ladder ended at rung D, feeds
 * their output through the same SSH output intake the relay uses, and removes them again.
 */
import type { SshPlainSshMode } from '../../shared/ssh-types'
import {
  getSshPtyProvider,
  isCurrentPtyExit,
  registerSshPtyProvider,
  unregisterSshPtyProvider
} from '../ipc/pty'
import {
  acceptSshPtyOutputData,
  acceptSshPtyOutputExit,
  allocateSshPtyProviderGeneration,
  closeSshPtyOutputGeneration
} from '../ipc/ssh-pty-output-intake-registry'
import { SshPlainShellPtyProvider } from '../providers/ssh-plain-shell-pty-provider'
import type { SshPtyExitCallback } from '../providers/ssh-pty-provider-contract'
import {
  getSshFilesystemProvider,
  registerSshFilesystemProvider,
  unregisterSshFilesystemProvider
} from '../providers/ssh-filesystem-dispatch'
import { SshSftpFilesystemProvider } from '../providers/ssh-sftp-filesystem-provider'
import type { SshConnection } from './ssh-connection'
import {
  clearSshPlainSshMode,
  plainSshModeFromRuntimeUnavailable,
  setSshPlainSshMode
} from './ssh-plain-ssh-mode'
import type { RemoteRuntimeUnavailableError } from './ssh-relay-runtime-resolution'

type PlainSshExitPayload = Parameters<SshPtyExitCallback>[0]

export class SshPlainSshModeSession {
  private left = false

  private constructor(
    readonly targetId: string,
    readonly mode: SshPlainSshMode,
    private readonly ptyProvider: SshPlainShellPtyProvider,
    private readonly fsProvider: SshSftpFilesystemProvider
  ) {}

  static enter(args: {
    targetId: string
    connection: SshConnection
    error: RemoteRuntimeUnavailableError
    onExitAccepted: (payload: PlainSshExitPayload) => void
  }): SshPlainSshModeSession {
    const { targetId, connection } = args
    const mode = plainSshModeFromRuntimeUnavailable(args.error)
    const generation = allocateSshPtyProviderGeneration()
    const windowsHost = args.error.data.host.platform === 'win32'
    const ptyProvider = new SshPlainShellPtyProvider(
      targetId,
      (pty) => connection.shell(pty),
      mode,
      !windowsHost,
      generation
    )
    const fsProvider = new SshSftpFilesystemProvider(
      targetId,
      (options) => connection.sftp(options),
      mode,
      windowsHost
    )
    const session = new SshPlainSshModeSession(targetId, mode, ptyProvider, fsProvider)
    ptyProvider.onData((payload) => {
      if (session.left) {
        return
      }
      void acceptSshPtyOutputData({
        id: payload.id,
        data: payload.data,
        providerGeneration: payload.providerGeneration,
        ptyIncarnation: payload.ptyIncarnation,
        rawLength: payload.data.length,
        transformed: false
      }).catch(() => {})
    })
    ptyProvider.onExit((payload) => {
      if (session.left || !isCurrentPtyExit(payload)) {
        return
      }
      void acceptSshPtyOutputExit({
        id: payload.id,
        code: payload.code,
        providerGeneration: payload.providerGeneration,
        ptyIncarnation: payload.ptyIncarnation
      })
        .then(() => args.onExitAccepted(payload))
        .catch(() => {})
    })
    setSshPlainSshMode(targetId, mode)
    registerSshPtyProvider(targetId, ptyProvider)
    registerSshFilesystemProvider(targetId, fsProvider)
    return session
  }

  probeTransport(timeoutMs: number): Promise<boolean> {
    return this.left ? Promise.resolve(false) : this.fsProvider.probeTransport(timeoutMs)
  }

  /** Transport gone or session torn down: open shells stay unverifiable, never exited. */
  leave(): void {
    if (this.left) {
      return
    }
    this.left = true
    clearSshPlainSshMode(this.targetId)
    closeSshPtyOutputGeneration(this.ptyProvider.providerGeneration, 'connection_lost')
    this.ptyProvider.dispose()
    this.fsProvider.dispose()
    if (getSshPtyProvider(this.targetId) === this.ptyProvider) {
      unregisterSshPtyProvider(this.targetId)
    }
    if (getSshFilesystemProvider(this.targetId) === this.fsProvider) {
      unregisterSshFilesystemProvider(this.targetId)
    }
  }
}

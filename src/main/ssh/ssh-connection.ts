/* eslint-disable max-lines -- Why: SSH connection lifecycle, credential retries, reconnect policy, and transport fallback are intentionally co-located so state transitions stay auditable in one file. */
import * as net from 'node:net'
import { createHash } from 'node:crypto'
import { Client as SshClient } from 'ssh2'
import type { ChildProcess } from 'node:child_process'
import type { ClientChannel, ConnectConfig, SFTPWrapper } from 'ssh2'
import type { SshTarget, SshConnectionState, SshConnectionStatus } from '../../shared/ssh-types'
import {
  getOrcaControlSocketPath,
  spawnSystemSsh,
  spawnSystemSshCommand,
  downloadFileViaSystemSsh,
  uploadDirectoryViaSystemSsh,
  uploadFileViaSystemSsh,
  writeBufferViaSystemSsh,
  writeFileViaSystemSsh,
  type SystemSshBuildArgsOptions,
  type SystemSshProcess
} from './ssh-system-fallback'
import { resolveWithSshG, type SshResolvedConfig } from './ssh-config-parser'
import { removeControlSocketPath } from './ssh-control-socket'
import {
  INITIAL_RETRY_ATTEMPTS,
  INITIAL_RETRY_DELAY_MS,
  RECONNECT_BACKOFF_MS,
  CONNECT_TIMEOUT_MS,
  isTransientError,
  isAuthError,
  isAgentFallbackError,
  isSystemSshFallbackError,
  isGssapiSystemSshFallbackCandidate,
  isPassphraseError,
  sleep,
  buildConnectConfig,
  resolveEffectiveProxy,
  spawnProxyCommand,
  wrapRemoteCommandForPosixShell,
  createSshOperationAbortError,
  type SshExecOptions,
  type SshConnectionCallbacks
} from './ssh-connection-utils'
import type { RemoteHostPlatform } from './ssh-remote-platform'
import type { FileUploadSession } from '../providers/types'
import { isSshSessionLimitError } from './ssh-session-limit-error'
import {
  createLinkedSshFileTransferSignal,
  raceSftpFileTransferWithAbort
} from './ssh-file-transfer-abort'
export type { SshConnectionCallbacks } from './ssh-connection-utils'

type SshRemoteFileOptions = {
  hostPlatform?: RemoteHostPlatform
}

// Upper bound on waiting for an aborted channel's open/close to settle before rejecting anyway.
const ABORTED_CHANNEL_CLOSE_GRACE_MS = 5_000

// Why: MaxSessions servers can transiently refuse a channel open; a refused open never ran the command, so retry is safe.
const SESSION_LIMIT_OPEN_RETRIES = 4
const SESSION_LIMIT_OPEN_RETRY_DELAY_MS = 150

function cloneResolvedConfig(config: SshResolvedConfig | null): SshResolvedConfig | null {
  if (!config) {
    return null
  }
  return { ...config, identityFile: [...config.identityFile] }
}

function isGitHubRestrictedShellProbeSuccess(
  target: SshTarget,
  resolvedConfig: SshResolvedConfig | null,
  code: number | null,
  stderr: string
): boolean {
  if (code !== 1) {
    return false
  }

  const effectiveUser = (target.username?.trim() || resolvedConfig?.user?.trim())?.toLowerCase()
  if (effectiveUser !== 'git') {
    return false
  }

  // GitHub appends git:// advisory lines after the invalid-command line (issue #6988), so match the first line only.
  const firstLine = stderr.split('\n', 1)[0]?.trim()
  if (firstLine !== 'Invalid command: echo ORCA-SYSTEM-SSH-OK') {
    return false
  }

  const resolvedHost = resolvedConfig?.hostname?.trim()
  const hostCandidates = resolvedHost ? [resolvedHost] : [target.host, target.configHost]

  return hostCandidates.some((host) => {
    const normalizedHost = host?.trim().toLowerCase()
    return normalizedHost === 'github.com' || normalizedHost === 'ssh.github.com'
  })
}

export class SshConnection {
  private client: SshClient | null = null
  private proxyProcess: ChildProcess | null = null
  private systemSsh: SystemSshProcess | null = null
  private systemCommandChannels = new Set<ClientChannel>()
  private systemOperationAbortController = new AbortController()
  private systemSshResolvedConfig: SshResolvedConfig | null = null
  private systemSshControlMasterDisabledForSession = false
  private systemSshGssapiOnlyForSession = false
  private useSystemSshTransport = false
  private state: SshConnectionState
  private callbacks: SshConnectionCallbacks
  private target: SshTarget
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private disposed = false
  private cachedPassphrase: string | null = null
  private cachedPassword: string | null = null
  private hostKeyFingerprint: string | undefined
  private connectGeneration = 0

  constructor(target: SshTarget, callbacks: SshConnectionCallbacks) {
    this.target = target
    this.callbacks = callbacks
    this.state = {
      targetId: target.id,
      status: 'disconnected',
      error: null,
      reconnectAttempt: 0,
      supportsFolderDownload: false
    }
  }

  getState(): SshConnectionState {
    return { ...this.state }
  }
  getClient(): SshClient | null {
    return this.client
  }
  usesSystemSshTransport(): boolean {
    return this.useSystemSshTransport
  }
  canRunConcurrentExecCommands(): boolean {
    if (!this.useSystemSshTransport) {
      return true
    }
    return (
      getOrcaControlSocketPath(this.target, {
        ...this.getSystemSshBuildArgsOptions()
      }) !== null
    )
  }
  getTarget(): SshTarget {
    return { ...this.target }
  }
  getSystemSshResolvedConfig(): SshResolvedConfig | null {
    return cloneResolvedConfig(this.systemSshResolvedConfig)
  }
  getHostKeyFingerprint(): string | undefined {
    // Why: system SSH does not expose its negotiated key; a fingerprint from a
    // failed ssh2 attempt may identify a different load-balanced execution host.
    return this.useSystemSshTransport ? undefined : this.hostKeyFingerprint
  }

  setCallbacks(callbacks: SshConnectionCallbacks): void {
    this.callbacks = callbacks
  }

  // Why: lets ssh:needsPassphrasePrompt skip redundant passphrase prompts on reconnect when the credential is already cached in-memory.
  hasCachedCredential(): boolean {
    return this.cachedPassphrase != null || this.cachedPassword != null
  }

  async exec(cmd: string, options?: SshExecOptions): Promise<ClientChannel> {
    if (options?.signal?.aborted) {
      throw createSshOperationAbortError()
    }
    if (this.useSystemSshTransport) {
      if (this.disposed || this.state.status !== 'connected') {
        throw new Error('Not connected')
      }
      return this.spawnTrackedSystemSshCommand(cmd, options)
    }
    if (!this.client) {
      throw new Error('Not connected')
    }
    const client = this.client
    const remoteCommand = options?.wrapCommand === false ? cmd : wrapRemoteCommandForPosixShell(cmd)
    return this.openSessionChannelWithRetry(
      () =>
        this.waitForSshCallback(
          'SSH exec channel timed out',
          (callback) => client.exec(remoteCommand, callback),
          (channel) => channel.close(),
          options?.signal,
          true
        ),
      options?.signal
    )
  }

  async sftp(options?: AbortSignal | { signal?: AbortSignal }): Promise<SFTPWrapper> {
    // Why: relay transfers pass a signal directly, while filesystem factories use an options object.
    const signal = options && 'aborted' in options ? options : options?.signal
    if (signal?.aborted) {
      throw createSshOperationAbortError()
    }
    if (this.useSystemSshTransport) {
      throw new Error('SFTP is not available when using system SSH transport')
    }
    if (!this.client) {
      throw new Error('Not connected')
    }
    const client = this.client
    return this.openSessionChannelWithRetry(
      () =>
        this.waitForSshCallback(
          'SSH SFTP channel timed out',
          (callback) => client.sftp(callback),
          (sftp) => sftp.end(),
          signal
        ),
      signal
    )
  }

  private async openSessionChannelWithRetry<T>(
    open: () => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    let lastError: unknown
    for (let attempt = 0; attempt < SESSION_LIMIT_OPEN_RETRIES; attempt++) {
      if (attempt > 0) {
        // Why: an abort must release the backoff immediately, not after it.
        if (!signal?.aborted) {
          await new Promise<void>((resolve) => {
            const onDelayDone = (): void => {
              clearTimeout(delayTimer)
              signal?.removeEventListener('abort', onDelayDone)
              resolve()
            }
            const delayTimer = setTimeout(onDelayDone, SESSION_LIMIT_OPEN_RETRY_DELAY_MS)
            signal?.addEventListener('abort', onDelayDone, { once: true })
          })
        }
        if (signal?.aborted) {
          throw createSshOperationAbortError()
        }
      }
      try {
        return await open()
      } catch (err) {
        if (!isSshSessionLimitError(err)) {
          throw err
        }
        lastError = err
      }
    }
    throw lastError
  }

  private waitForSshCallback<T>(
    timeoutMessage: string,
    register: (callback: (error: Error | undefined, value: T) => void) => void,
    cleanupLateValue?: (value: T) => void,
    signal?: AbortSignal,
    trackRemoteCommandTermination = false
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      type ChannelOpenTerminationError = Error & { sshChannelCloseConfirmed: boolean }
      let settled = false
      let unconfirmedOpenError: ChannelOpenTerminationError | null = null
      const markOpenUnconfirmed = (error: Error): Error => {
        if (!trackRemoteCommandTermination) {
          return error
        }
        unconfirmedOpenError = Object.assign(error, { sshChannelCloseConfirmed: false })
        return unconfirmedOpenError
      }
      // Why: an in-flight open holds a MaxSessions slot; reject the caller now, then settle from the open callback once the late channel closes.
      let abortRequested = false
      let abortDeadlineTimer: NodeJS.Timeout | undefined
      const cleanup = (): void => {
        clearTimeout(timer)
        clearTimeout(abortDeadlineTimer)
        signal?.removeEventListener('abort', onAbort)
      }
      const onAbort = (): void => {
        abortRequested = true
        // Why: a hung socket may never invoke the open callback; bound the aborted caller's wait instead of pinning it for CONNECT_TIMEOUT_MS.
        abortDeadlineTimer = setTimeout(() => {
          settled = true
          cleanup()
          reject(markOpenUnconfirmed(createSshOperationAbortError()))
        }, ABORTED_CHANNEL_CLOSE_GRACE_MS)
      }
      const timer = setTimeout(() => {
        settled = true
        cleanup()
        reject(
          markOpenUnconfirmed(
            abortRequested ? createSshOperationAbortError() : new Error(timeoutMessage)
          )
        )
      }, CONNECT_TIMEOUT_MS)
      const discardLateValue = (value: T, onClose?: () => void): void => {
        const emitter = value as Partial<NodeJS.EventEmitter> & {
          resume?: () => void
          stderr?: Partial<NodeJS.EventEmitter> & { resume?: () => void }
        }
        const swallowLateError = (): void => {}
        emitter.on?.('error', swallowLateError)
        emitter.stderr?.on?.('error', swallowLateError)
        if (onClose) {
          emitter.once?.('close', onClose)
        }
        // Why: ssh2 withholds CHANNEL_CLOSE while discarded exec streams remain unread, and teardown errors have no other owner.
        emitter.resume?.()
        emitter.stderr?.resume?.()
        try {
          cleanupLateValue?.(value)
        } catch {
          /* best effort */
        }
      }
      const rejectAfterClose = (value: T): void => {
        const abortError = markOpenUnconfirmed(createSshOperationAbortError())
        const emitter = value as Partial<NodeJS.EventEmitter> & {
          resume?: () => void
          stderr?: { resume?: () => void }
        }
        let finished = false
        const done = (): void => {
          if (finished) {
            return
          }
          finished = true
          clearTimeout(closeGraceTimer)
          emitter.removeListener?.('close', confirmAndDone)
          reject(abortError)
        }
        const confirmAndDone = (): void => {
          if (unconfirmedOpenError === abortError) {
            unconfirmedOpenError.sshChannelCloseConfirmed = true
          }
          done()
        }
        // Why: bounded so a remote that never confirms the close can't hang the aborted operation forever.
        const closeGraceTimer = setTimeout(done, ABORTED_CHANNEL_CLOSE_GRACE_MS)
        if (typeof emitter.once === 'function') {
          emitter.once('close', confirmAndDone)
        }
        // Why: ssh2 withholds 'close' until the channel's streams are drained; nobody else will read this discarded channel.
        discardLateValue(value)
        if (typeof emitter.once !== 'function') {
          done()
        }
      }
      const finish = (error: Error | undefined, value?: T): void => {
        if (settled) {
          // Why: ssh2 can invoke the open callback after our timeout rejected; close that late channel so it isn't left open with no owner.
          if (!error && value !== undefined) {
            discardLateValue(value, () => {
              if (unconfirmedOpenError) {
                unconfirmedOpenError.sshChannelCloseConfirmed = true
              }
            })
          }
          return
        }
        settled = true
        cleanup()
        if (abortRequested) {
          if (!error && value !== undefined) {
            rejectAfterClose(value)
          } else {
            reject(createSshOperationAbortError())
          }
          return
        }
        if (error) {
          reject(error)
          return
        }
        resolve(value as T)
      }
      if (signal?.aborted) {
        // No open is in flight yet, so failing fast leaks nothing.
        cleanup()
        reject(createSshOperationAbortError())
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })

      try {
        // Why: higher-level channel timers start only after ssh2's open callback; a stale SSH socket can otherwise keep exec/sftp stuck.
        register(finish)
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  async uploadDirectory(
    localDir: string,
    remoteDir: string,
    options?: SshRemoteFileOptions & { signal?: AbortSignal }
  ): Promise<void> {
    // Why: relay-deploy timeout and connection teardown are independent owners; either must stop a transfer that could outlive its lock.
    const linkedSignal = createLinkedSshFileTransferSignal(
      [this.systemOperationAbortController.signal, options?.signal].filter(
        (signal): signal is AbortSignal => signal !== undefined
      )
    )
    try {
      if (!this.useSystemSshTransport) {
        const sftp = await this.sftp(linkedSignal.signal)
        const swallowLateSftpError = (): void => {}
        let sftpEndRequested = false
        const endSftp = (): void => {
          if (!sftpEndRequested) {
            sftpEndRequested = true
            sftp.end()
          }
        }
        sftp.on('error', swallowLateSftpError)
        sftp.once('close', () => sftp.removeListener('error', swallowLateSftpError))
        try {
          const { uploadDirectory } = await import('./ssh-relay-deploy-helpers')
          await raceSftpFileTransferWithAbort(
            uploadDirectory(sftp, localDir, remoteDir),
            linkedSignal.signal,
            (onClose) => {
              sftp.once('close', onClose)
              endSftp()
            }
          )
        } finally {
          endSftp()
        }
        return
      }
      await uploadDirectoryViaSystemSsh(this.target, localDir, remoteDir, {
        signal: linkedSignal.signal,
        hostPlatform: options?.hostPlatform,
        ...this.getSystemSshBuildArgsOptions()
      })
    } finally {
      linkedSignal.dispose()
    }
  }

  async downloadFile(
    remotePath: string,
    localPath: string,
    options?: SshRemoteFileOptions
  ): Promise<void> {
    if (!this.useSystemSshTransport) {
      const sftp = await this.sftp()
      try {
        const { fastGetViaSftp } = await import('../providers/ssh-filesystem-provider-sftp')
        await fastGetViaSftp(sftp, remotePath, localPath)
      } finally {
        sftp.end()
      }
      return
    }
    await downloadFileViaSystemSsh(this.target, remotePath, localPath, {
      signal: this.systemOperationAbortController.signal,
      hostPlatform: options?.hostPlatform,
      ...this.getSystemSshBuildArgsOptions()
    })
  }

  async openFileUploadSession(options?: SshRemoteFileOptions): Promise<FileUploadSession> {
    if (!this.useSystemSshTransport) {
      const sftp = await this.sftp()
      const { uploadFile } = await import('./sftp-upload')
      return {
        uploadFile: (localPath, remotePath, uploadOptions) =>
          uploadFile(sftp, localPath, remotePath, uploadOptions),
        close: () => sftp.end()
      }
    }
    // Why: disconnect replaces the connection controller, so an existing import session must stay bound to the signal and SSH config it opened with.
    const signal = this.systemOperationAbortController.signal
    const buildArgsOptions = this.getSystemSshBuildArgsOptions()
    return {
      uploadFile: (localPath, remotePath, uploadOptions) =>
        uploadFileViaSystemSsh(this.target, localPath, remotePath, {
          signal,
          hostPlatform: options?.hostPlatform,
          exclusive: uploadOptions?.exclusive,
          ...buildArgsOptions
        }),
      close: () => {}
    }
  }

  async writeFile(
    remotePath: string,
    contents: string,
    options?: SshRemoteFileOptions & { signal?: AbortSignal }
  ): Promise<void> {
    // Keep package/version writes under the same dual cancellation contract as uploads.
    const linkedSignal = createLinkedSshFileTransferSignal(
      [this.systemOperationAbortController.signal, options?.signal].filter(
        (signal): signal is AbortSignal => signal !== undefined
      )
    )
    try {
      if (!this.useSystemSshTransport) {
        const sftp = await this.sftp(linkedSignal.signal)
        const swallowLateSftpError = (): void => {}
        let sftpEndRequested = false
        const endSftp = (): void => {
          if (!sftpEndRequested) {
            sftpEndRequested = true
            sftp.end()
          }
        }
        sftp.on('error', swallowLateSftpError)
        sftp.once('close', () => sftp.removeListener('error', swallowLateSftpError))
        try {
          const write = new Promise<void>((resolve, reject) => {
            const ws = sftp.createWriteStream(remotePath)
            let settled = false
            const cleanup = (): void => {
              sftp.removeListener('error', onError)
              ws.removeListener('close', onClose)
              ws.removeListener('error', onError)
            }
            const onClose = (): void => {
              if (settled) {
                return
              }
              settled = true
              cleanup()
              resolve()
            }
            const onError = (err: Error): void => {
              if (settled) {
                return
              }
              settled = true
              cleanup()
              reject(err)
            }
            sftp.prependOnceListener('error', onError)
            ws.once('close', onClose)
            ws.once('error', onError)
            ws.end(contents)
          })
          await raceSftpFileTransferWithAbort(write, linkedSignal.signal, (onClose) => {
            sftp.once('close', onClose)
            endSftp()
          })
        } finally {
          endSftp()
        }
        return
      }
      await writeFileViaSystemSsh(this.target, remotePath, contents, {
        signal: linkedSignal.signal,
        hostPlatform: options?.hostPlatform,
        ...this.getSystemSshBuildArgsOptions()
      })
    } finally {
      linkedSignal.dispose()
    }
  }

  async writeBuffer(
    remotePath: string,
    contents: Buffer,
    options?: SshRemoteFileOptions & { append?: boolean; exclusive?: boolean }
  ): Promise<void> {
    if (!this.useSystemSshTransport) {
      const sftp = await this.sftp()
      try {
        const { uploadBuffer } = await import('./sftp-upload')
        await uploadBuffer(sftp, contents, remotePath, options)
      } finally {
        sftp.end()
      }
      return
    }
    await writeBufferViaSystemSsh(this.target, remotePath, contents, {
      signal: this.systemOperationAbortController.signal,
      hostPlatform: options?.hostPlatform,
      append: options?.append,
      exclusive: options?.exclusive,
      ...this.getSystemSshBuildArgsOptions()
    })
  }

  async connect(): Promise<void> {
    if (this.disposed) {
      throw new Error('Connection disposed')
    }

    let lastError: Error | null = null

    for (let attempt = 0; attempt < INITIAL_RETRY_ATTEMPTS; attempt++) {
      try {
        await this.attemptConnect()
        return
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err))

        // Why: a concurrent disconnect() already set 'disconnected'; a cancelled attempt's late error must not overwrite it with auth-failed/error.
        if (this.disposed) {
          throw lastError
        }

        if (isAuthError(lastError) || isPassphraseError(lastError)) {
          this.setState('auth-failed', lastError.message)
          throw lastError
        }

        if (!isTransientError(lastError)) {
          this.setState('error', lastError.message)
          throw lastError
        }

        if (attempt < INITIAL_RETRY_ATTEMPTS - 1) {
          await sleep(INITIAL_RETRY_DELAY_MS)
        }
      }
    }

    const finalError = lastError ?? new Error('Connection failed')
    this.setState('error', finalError.message)
    throw finalError
  }

  private async attemptConnect(): Promise<void> {
    this.setState('connecting')
    this.proxyProcess?.kill()
    this.proxyProcess = null
    const connectGeneration = ++this.connectGeneration

    const resolved = await resolveWithSshG(this.target.configHost || this.target.label).catch(
      () => null
    )
    if (shouldUseSystemSshTransport(this.target, resolved)) {
      await this.doSystemSshProbeWithControlMasterRetry(connectGeneration, resolved)
      return
    }
    // Why: ssh2 lacks gssapi-with-mic; GSSAPIAuthentication hosts try Kerberos SSO via system OpenSSH first, then fall through to key/credential auth.
    if (this.target.gssapiAuthentication === true) {
      try {
        await this.doSystemSshProbeWithControlMasterRetry(connectGeneration, resolved, true)
        return
      } catch (probeErr) {
        if (this.disposed || !this.isCurrentConnectAttempt(connectGeneration)) {
          throw probeErr
        }
      }
    }
    // Why: a synchronous spawn throw bypasses the probe's catch, so clear system-transport state here or exec/sftp keep routing through the failed transport.
    this.systemSshResolvedConfig = null
    this.systemSshControlMasterDisabledForSession = false
    this.systemSshGssapiOnlyForSession = false
    this.useSystemSshTransport = false

    const config = buildConnectConfig(this.target, resolved)

    // Why: ssh2 doesn't support ProxyCommand/ProxyJump natively; spawn the resolved proxy and pipe its stdin/stdout as config.sock.
    const effectiveProxy = resolveEffectiveProxy(this.target, resolved)
    if (effectiveProxy) {
      const proxy = spawnProxyCommand(effectiveProxy, config.host!, config.port!, config.username!)
      this.proxyProcess = proxy.process
      config.sock = proxy.sock
    }

    if (this.cachedPassphrase) {
      config.passphrase = this.cachedPassphrase
    }
    if (this.cachedPassword) {
      config.password = this.cachedPassword
    }

    try {
      await this.doSsh2Connect(config, connectGeneration)
    } catch (err) {
      if (!(err instanceof Error)) {
        this.proxyProcess?.kill()
        this.proxyProcess = null
        throw err
      }

      if (isSystemSshFallbackError(err)) {
        this.proxyProcess?.kill()
        this.proxyProcess = null
        try {
          // Why: on macOS, per-app network policy can block Orca's direct TCP socket while the system OpenSSH binary is still allowed.
          await this.doSystemSshProbeWithControlMasterRetry(connectGeneration, resolved)
          return
        } catch {
          this.systemSshResolvedConfig = null
          this.systemSshControlMasterDisabledForSession = false
          this.systemSshGssapiOnlyForSession = false
          this.useSystemSshTransport = false
          throw err
        }
      }

      let authError = err
      let passphrasePromptHandled = false
      let credentialRetryConfig = config

      // Why: ssh2 parses encrypted privateKey before agent auth; when an agent exists, let it try first and fall back to direct key parsing only if it fails.
      if (isAgentFallbackError(authError) && config.agent && !config.privateKey) {
        const keyConfig = buildConnectConfig(this.target, resolved, {
          includeAgent: false,
          includePrivateKey: true
        })
        // Why: if the agent path failed, password/passphrase retries must not reuse the same agent-only config.
        credentialRetryConfig = keyConfig
        if (this.cachedPassphrase) {
          keyConfig.passphrase = this.cachedPassphrase
        }
        if (this.cachedPassword) {
          keyConfig.password = this.cachedPassword
        }
        if (keyConfig.privateKey || keyConfig.password) {
          this.respawnProxy(keyConfig, effectiveProxy)
          try {
            await this.doSsh2Connect(keyConfig, connectGeneration)
            return
          } catch (keyErr) {
            if (!(keyErr instanceof Error)) {
              this.proxyProcess?.kill()
              this.proxyProcess = null
              throw keyErr
            }
            authError = keyErr
            // Why: with GSSAPI enabled, let the reactive system-ssh probe try a Kerberos ticket before prompting for the passphrase; the prompt still runs if it fails.
            if (
              isPassphraseError(authError) &&
              !this.cachedPassphrase &&
              !isGssapiSystemSshFallbackCandidate(authError, this.target, resolved)
            ) {
              passphrasePromptHandled = true
              const detail = this.target.identityFile || resolved?.identityFile?.[0] || '(unknown)'
              const val = await this.callbacks.onCredentialRequest?.(
                this.target.id,
                'passphrase',
                detail
              )
              if (val) {
                this.cachedPassphrase = val
                keyConfig.passphrase = val
                this.respawnProxy(keyConfig, effectiveProxy)
                await this.doSsh2Connect(keyConfig, connectGeneration)
                return
              }
            }
          }
        }
      }

      // Why: a Kerberos ticket may authenticate where keys did not; try the system ssh binary before falling back to interactive prompts.
      if (isGssapiSystemSshFallbackCandidate(authError, this.target, resolved)) {
        this.proxyProcess?.kill()
        this.proxyProcess = null
        try {
          await this.doSystemSshProbeWithControlMasterRetry(connectGeneration, resolved, true)
          return
        } catch {
          this.systemSshResolvedConfig = null
          this.systemSshControlMasterDisabledForSession = false
          this.systemSshGssapiOnlyForSession = false
          this.useSystemSshTransport = false
        }
        // Why: if a disconnect/reconnect superseded this attempt mid-probe, throw the cancellation error (not the stale authError) so connect() doesn't post auth-failed.
        if (this.disposed || !this.isCurrentConnectAttempt(connectGeneration)) {
          throw this.createCancelledConnectAttemptError()
        }
      }

      if (!this.callbacks.onCredentialRequest) {
        this.proxyProcess?.kill()
        this.proxyProcess = null
        throw authError
      }

      // Why: prompt for passphrase on encrypted-key error, then retry with a fresh proxy socket (ssh2 may have destroyed the original).
      if (isPassphraseError(authError) && !this.cachedPassphrase && !passphrasePromptHandled) {
        const detail = this.target.identityFile || resolved?.identityFile?.[0] || '(unknown)'
        const val = await this.callbacks.onCredentialRequest(this.target.id, 'passphrase', detail)
        if (val) {
          this.cachedPassphrase = val
          credentialRetryConfig.passphrase = val
          this.respawnProxy(credentialRetryConfig, effectiveProxy)
          await this.doSsh2Connect(credentialRetryConfig, connectGeneration)
          return
        }
      }
      // Why: an agent socket failure can still be recovered by password auth, but the retry must use the no-agent config selected above.
      if (isAgentFallbackError(authError) && !this.cachedPassword) {
        const val = await this.callbacks.onCredentialRequest(
          this.target.id,
          'password',
          config.host || this.target.label
        )
        if (val) {
          this.cachedPassword = val
          credentialRetryConfig.password = val
          this.respawnProxy(credentialRetryConfig, effectiveProxy)
          await this.doSsh2Connect(credentialRetryConfig, connectGeneration)
          return
        }
      }
      this.proxyProcess?.kill()
      this.proxyProcess = null
      throw authError
    }
  }

  async reconnect(): Promise<void> {
    if (this.disposed || this.state.status === 'connecting') {
      return
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    // Why: OS sleep/wake can leave ssh2 thinking a dead TCP socket is still connected; tear down and reconnect so the relay can reattach remote PTYs.
    this.closeTransportsForReconnect()
    this.state.reconnectAttempt = 0
    this.setState('reconnecting')
    await this.runReconnectAttempt(0)
  }

  private async doSystemSshProbe(connectGeneration: number): Promise<void> {
    this.useSystemSshTransport = true
    this.client = null
    this.proxyProcess?.kill()
    this.proxyProcess = null

    // Why: this probe runs before remote platform detection; a raw echo works under POSIX shells, cmd.exe, and PowerShell, but `/bin/sh` wrapping does not.
    const channel = this.spawnTrackedSystemSshCommand('echo ORCA-SYSTEM-SSH-OK', {
      wrapCommand: false
    })
    try {
      await new Promise<void>((resolve, reject) => {
        let stdout = ''
        let stderr = ''
        let settled = false
        const cleanup = (): void => {
          clearTimeout(timeout)
          channel.off('data', onStdoutData)
          channel.stderr.off('data', onStderrData)
          channel.off('error', onError)
          channel.off('close', onClose)
          this.systemCommandChannels.delete(channel)
        }
        const settle = (callback: () => void): void => {
          if (settled) {
            return
          }
          settled = true
          cleanup()
          callback()
        }
        const onStdoutData = (data: Buffer): void => {
          stdout += data.toString('utf-8')
        }
        const onStderrData = (data: Buffer): void => {
          stderr += data.toString('utf-8')
        }
        const onError = (err: Error): void => {
          settle(() => reject(err))
        }
        const onClose = (code: number | null): void => {
          settle(() => {
            if (this.disposed || connectGeneration !== this.connectGeneration) {
              reject(new Error('SSH connection attempt was cancelled'))
              return
            }
            if (
              (code === 0 && stdout.includes('ORCA-SYSTEM-SSH-OK')) ||
              isGitHubRestrictedShellProbeSuccess(
                this.target,
                this.systemSshResolvedConfig,
                code,
                stderr
              )
            ) {
              this.setState('connected')
              resolve()
              return
            }
            reject(
              new Error(
                `System SSH probe failed${code != null ? ` (exit ${code})` : ''}.${stderr ? ` stderr: ${stderr.trim()}` : ''}`
              )
            )
          })
        }
        const timeout = setTimeout(() => {
          settle(() => {
            channel.close()
            reject(new Error('System SSH connection timed out'))
          })
        }, CONNECT_TIMEOUT_MS)

        channel.on('data', onStdoutData)
        channel.stderr.on('data', onStderrData)
        channel.on('error', onError)
        channel.on('close', onClose)
      })
    } catch (err) {
      this.useSystemSshTransport = false
      this.systemSshResolvedConfig = null
      throw err
    }
  }

  private async doSystemSshProbeWithControlMasterRetry(
    connectGeneration: number,
    resolved: SshResolvedConfig | null,
    gssapiOnly = false
  ): Promise<void> {
    this.systemSshResolvedConfig = cloneResolvedConfig(resolved)
    this.systemSshControlMasterDisabledForSession = false
    this.systemSshGssapiOnlyForSession = gssapiOnly
    const controlPath = getOrcaControlSocketPath(this.target, {
      resolvedConfig: this.systemSshResolvedConfig,
      gssapiOnly: this.systemSshGssapiOnlyForSession
    })
    try {
      await this.doSystemSshProbe(connectGeneration)
    } catch (err) {
      if (!controlPath || this.disposed || connectGeneration !== this.connectGeneration) {
        throw err
      }
      removeControlSocketPath(controlPath)
      this.systemSshResolvedConfig = cloneResolvedConfig(resolved)
      this.systemSshControlMasterDisabledForSession = true
      try {
        await this.doSystemSshProbe(connectGeneration)
      } catch (retryErr) {
        this.systemSshControlMasterDisabledForSession = false
        throw retryErr
      }
    }
  }

  private async spawnSystemSshWithControlMasterRetry(
    controlPath: string | null,
    connectGeneration: number
  ): Promise<SystemSshProcess> {
    try {
      return await this.spawnAndWaitForSystemSsh(connectGeneration)
    } catch (err) {
      if (!this.isCurrentConnectAttempt(connectGeneration)) {
        throw this.createCancelledConnectAttemptError()
      }
      if (!controlPath) {
        throw err
      }
      removeControlSocketPath(controlPath)
      this.systemSshControlMasterDisabledForSession = true
      if (!this.isCurrentConnectAttempt(connectGeneration)) {
        throw this.createCancelledConnectAttemptError()
      }
      try {
        return await this.spawnAndWaitForSystemSsh(connectGeneration)
      } catch (retryErr) {
        if (this.isCurrentConnectAttempt(connectGeneration)) {
          this.systemSshControlMasterDisabledForSession = false
        }
        throw retryErr
      }
    }
  }

  private async spawnAndWaitForSystemSsh(connectGeneration: number): Promise<SystemSshProcess> {
    if (!this.isCurrentConnectAttempt(connectGeneration)) {
      throw this.createCancelledConnectAttemptError()
    }
    const proc = spawnSystemSsh(this.target, this.getSystemSshBuildArgsOptions())
    this.systemSsh = proc
    let settled = false
    await new Promise<void>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout>
      const clearCurrentProcess = (): void => {
        if (this.systemSsh === proc) {
          this.systemSsh = null
        }
      }
      const cleanup = (): void => {
        clearTimeout(timeout)
        proc.stdout.off('data', onReady)
      }
      const settle = (callback: () => void): void => {
        if (settled) {
          return
        }
        settled = true
        cleanup()
        callback()
      }
      const cancelStartup = (): void => {
        clearCurrentProcess()
        proc.kill()
        reject(this.createCancelledConnectAttemptError())
      }
      const onReady = (): void => {
        // Why: direct system SSH has the same late-ready race as ssh2; disconnect/reconnect must own the generation before state flips.
        if (!this.isCurrentConnectAttempt(connectGeneration)) {
          settle(cancelStartup)
          return
        }
        settle(resolve)
      }
      timeout = setTimeout(() => {
        settle(() => {
          clearCurrentProcess()
          proc.kill()
          reject(new Error('System SSH connection timed out'))
        })
      }, CONNECT_TIMEOUT_MS)
      proc.stdout.once('data', onReady)
      proc.onExit((code) => {
        if (settled) {
          return
        }
        settle(() => {
          clearCurrentProcess()
          if (!this.isCurrentConnectAttempt(connectGeneration)) {
            reject(this.createCancelledConnectAttemptError())
            return
          }
          reject(
            new Error(
              code !== 0
                ? `System SSH exited with code ${code}`
                : 'System SSH exited before producing output'
            )
          )
        })
      })
    })
    if (!this.isCurrentConnectAttempt(connectGeneration)) {
      if (this.systemSsh === proc) {
        this.systemSsh = null
      }
      proc.kill()
      throw this.createCancelledConnectAttemptError()
    }
    return proc
  }

  private isCurrentConnectAttempt(connectGeneration: number): boolean {
    return !this.disposed && connectGeneration === this.connectGeneration
  }

  private createCancelledConnectAttemptError(): Error {
    return new Error('SSH connection attempt was cancelled')
  }

  private spawnTrackedSystemSshCommand(command: string, options?: SshExecOptions): ClientChannel {
    if (options?.signal?.aborted) {
      throw createSshOperationAbortError()
    }
    const buildArgsOptions = this.getSystemSshBuildArgsOptions()
    const commandOptions =
      options === undefined && Object.keys(buildArgsOptions).length === 0
        ? undefined
        : { ...options, ...buildArgsOptions }
    const channel =
      commandOptions === undefined
        ? spawnSystemSshCommand(this.target, command)
        : spawnSystemSshCommand(this.target, command, commandOptions)
    this.systemCommandChannels.add(channel)
    const onAbort = (): void => {
      channel.close()
    }
    const cleanup = (): void => {
      options?.signal?.removeEventListener('abort', onAbort)
      this.systemCommandChannels.delete(channel)
    }
    options?.signal?.addEventListener('abort', onAbort, { once: true })
    channel.once('close', cleanup)
    channel.once('error', cleanup)
    return channel
  }

  private getSystemSshBuildArgsOptions(): SystemSshBuildArgsOptions {
    const options: SystemSshBuildArgsOptions = {}
    if (this.systemSshResolvedConfig) {
      options.resolvedConfig = this.systemSshResolvedConfig
    }
    if (this.systemSshControlMasterDisabledForSession) {
      options.disableControlMaster = true
    }
    if (this.systemSshGssapiOnlyForSession) {
      options.gssapiOnly = true
    }
    return options
  }

  // Why: ssh2 may destroy the proxy socket on auth failure, so credential retries need a fresh proxy process and Duplex stream.
  private respawnProxy(
    config: ConnectConfig,
    proxy: ReturnType<typeof resolveEffectiveProxy> | null | undefined
  ): void {
    if (!proxy) {
      return
    }
    this.proxyProcess?.kill()
    const p = spawnProxyCommand(proxy, config.host!, config.port!, config.username!)
    this.proxyProcess = p.process
    config.sock = p.sock
  }

  private doSsh2Connect(config: ConnectConfig, connectGeneration: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const client = new SshClient()
      let settled = false

      // Why: the relay uses the negotiated server key to isolate shared-home
      // install locks without comparing PIDs from an unrelated SSH host.
      config.hostVerifier = (key: Buffer): boolean => {
        if (!this.disposed && connectGeneration === this.connectGeneration) {
          const digest = createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
          this.hostKeyFingerprint = `SHA256:${digest}`
        }
        return true
      }

      const cleanupStartupListeners = (): void => {
        client.off('ready', onReady)
        client.off('error', onStartupError)
      }
      const swallowLateStartupError = (): void => {
        // Why: ssh2 can emit another socket error while destroying a settled pre-handshake client.
      }
      const guardStartupDestroy = (): void => {
        client.on('error', swallowLateStartupError)
      }

      const onReady = (): void => {
        if (settled) {
          return
        }
        // Why: connect() completion races with disconnect(); a late ready must not resurrect a torn-down client after generation/disposed changes.
        if (this.disposed || connectGeneration !== this.connectGeneration) {
          settled = true
          guardStartupDestroy()
          cleanupStartupListeners()
          client.end()
          client.destroy()
          reject(new Error('SSH connection attempt was cancelled'))
          return
        }
        settled = true
        this.client = client
        this.proxyProcess = null
        this.setupDisconnectHandler(client)
        cleanupStartupListeners()
        // Why: ssh2 leaves Nagle on; enable TCP_NODELAY so keystrokes don't stack with delayed-ACK (~40ms each). No-op for proxy sockets.
        const sock = (client as unknown as { _sock?: { setNoDelay?: unknown } })._sock
        if (sock instanceof net.Socket) {
          console.warn(`[ssh] TCP_NODELAY enabled for ${this.target.label}`)
        } else {
          console.warn(`[ssh] TCP_NODELAY skipped for ${this.target.label} (proxy socket)`)
        }
        client.setNoDelay(true)
        this.setState('connected')
        resolve()
      }

      const onStartupError = (err: Error): void => {
        if (settled) {
          return
        }
        guardStartupDestroy()
        cleanupStartupListeners()
        settled = true
        client.destroy()
        reject(err)
      }

      client.on('ready', onReady)
      client.on('error', onStartupError)
      client.connect(config)
    })
  }

  // Why: guard on identity so a late event from the old client can't null out a successful reconnect.
  private setupDisconnectHandler(client: SshClient): void {
    const onDrop = () => {
      if (this.disposed || this.client !== client) {
        return
      }
      this.client = null
      this.scheduleReconnect()
    }
    client.on('end', onDrop)
    client.on('close', onDrop)
    client.on('error', (err) => {
      if (this.disposed || this.client !== client) {
        return
      }
      console.warn(`[ssh] Connection error for ${this.target.label}: ${err.message}`)
      this.client = null
      this.scheduleReconnect()
    })
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) {
      return
    }
    const attempt = this.state.reconnectAttempt
    if (attempt >= RECONNECT_BACKOFF_MS.length) {
      this.setState('reconnection-failed', 'Max reconnection attempts reached')
      return
    }
    this.setState('reconnecting')
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null
      if (this.disposed) {
        return
      }
      await this.runReconnectAttempt(attempt)
    }, RECONNECT_BACKOFF_MS[attempt])
  }

  private async runReconnectAttempt(attempt: number): Promise<void> {
    try {
      // Why: reset before connecting so the 'connected' broadcast carries reconnectAttempt=0, which ssh.ts uses to trigger relay re-establishment.
      this.state.reconnectAttempt = 0
      await this.attemptConnect()
    } catch (err) {
      if (this.disposed) {
        return
      }
      const error = err instanceof Error ? err : new Error(String(err))
      if (isAuthError(error) || isPassphraseError(error)) {
        this.setState('auth-failed', error.message)
        return
      }
      if (!isTransientError(error)) {
        this.setState('error', error.message)
        return
      }
      this.state.reconnectAttempt = attempt + 1
      this.scheduleReconnect()
    }
  }

  private closeTransportsForReconnect(): void {
    this.connectGeneration += 1
    const client = this.client
    this.client = null
    try {
      client?.end()
      client?.destroy()
    } catch {
      /* best-effort transport teardown */
    }
    this.proxyProcess?.kill()
    this.proxyProcess = null
    this.systemOperationAbortController.abort()
    this.systemOperationAbortController = new AbortController()
    for (const channel of this.systemCommandChannels) {
      channel.close()
    }
    this.systemCommandChannels.clear()
    this.systemSsh?.kill()
    this.systemSsh = null
    this.systemSshResolvedConfig = null
    this.systemSshControlMasterDisabledForSession = false
    this.systemSshGssapiOnlyForSession = false
    this.useSystemSshTransport = false
  }

  async connectViaSystemSsh(): Promise<SystemSshProcess> {
    if (this.disposed) {
      throw new Error('Connection disposed')
    }
    const connectGeneration = ++this.connectGeneration
    this.systemSsh?.kill()
    this.systemSsh = null
    this.systemSshResolvedConfig = null
    this.systemSshControlMasterDisabledForSession = false
    this.systemSshGssapiOnlyForSession = false
    this.useSystemSshTransport = false
    this.setState('connecting')
    try {
      const resolved = await resolveWithSshG(this.target.configHost || this.target.label).catch(
        () => null
      )
      if (!this.isCurrentConnectAttempt(connectGeneration)) {
        throw this.createCancelledConnectAttemptError()
      }
      this.systemSshResolvedConfig = cloneResolvedConfig(resolved)
      const controlPath = getOrcaControlSocketPath(this.target, {
        resolvedConfig: this.systemSshResolvedConfig
      })
      const proc = await this.spawnSystemSshWithControlMasterRetry(controlPath, connectGeneration)
      if (!this.isCurrentConnectAttempt(connectGeneration)) {
        if (this.systemSsh === proc) {
          this.systemSsh = null
        }
        proc.kill()
        throw this.createCancelledConnectAttemptError()
      }
      this.systemSsh = proc
      this.useSystemSshTransport = true
      this.setState('connected')
      // Why: register the reconnect handler only after handshake succeeds (the onExit above guards with `settled`).
      proc.onExit(() => {
        if (!this.disposed && this.systemSsh === proc) {
          this.systemSsh = null
          this.scheduleReconnect()
        }
      })
      return proc
    } catch (err) {
      if (!this.isCurrentConnectAttempt(connectGeneration)) {
        throw err
      }
      this.useSystemSshTransport = false
      this.systemSshResolvedConfig = null
      this.systemSshControlMasterDisabledForSession = false
      this.systemSshGssapiOnlyForSession = false
      this.setState('error', err instanceof Error ? err.message : String(err))
      throw err
    }
  }

  async disconnect(): Promise<void> {
    this.disposed = true
    this.connectGeneration += 1
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
    }
    this.reconnectTimer = null
    this.cachedPassphrase = null
    this.cachedPassword = null
    this.client?.end()
    this.client = null
    this.proxyProcess?.kill()
    this.proxyProcess = null
    this.systemOperationAbortController.abort()
    this.systemOperationAbortController = new AbortController()
    for (const channel of this.systemCommandChannels) {
      channel.close()
    }
    this.systemCommandChannels.clear()
    this.systemSsh?.kill()
    this.systemSsh = null
    this.systemSshResolvedConfig = null
    this.systemSshControlMasterDisabledForSession = false
    this.systemSshGssapiOnlyForSession = false
    this.useSystemSshTransport = false
    this.setState('disconnected')
  }

  private setState(status: SshConnectionStatus, error?: string): void {
    this.state = {
      ...this.state,
      status,
      error: error ?? null,
      supportsFolderDownload: status === 'connected' && !this.useSystemSshTransport
    }
    this.callbacks.onStateChange(this.target.id, { ...this.state })
  }
}

export function shouldUseSystemSshTransport(
  target: SshTarget,
  resolved: Pick<SshResolvedConfig, 'proxyUseFdpass' | 'proxyCommand' | 'proxyJump'> | null
): boolean {
  return (
    process.env.ORCA_SSH_FORCE_SYSTEM_TRANSPORT === '1' ||
    target.proxyCommand != null ||
    target.jumpHost != null ||
    resolved?.proxyUseFdpass === true ||
    resolved?.proxyCommand != null ||
    resolved?.proxyJump != null
  )
}

export { SshConnectionManager } from './ssh-connection-manager'

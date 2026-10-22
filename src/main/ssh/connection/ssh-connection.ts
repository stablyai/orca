/* eslint-disable max-lines -- Why: the connect attempt (transport choice, the system-ssh ControlMaster retry, the ssh2 proxy and credential prompts) and teardown all read and write one generation, proxy, transport flags and cached sign-in; splitting them would spread each guard across files. Reconnect and channel opening live in their own modules. */
import {
  createSshFileUploadSession,
  downloadSshFile,
  uploadSshDirectory,
  writeSshBuffer,
  writeSshFile,
  type SshFileTransferHost,
  type SshRemoteFileOptions
} from './ssh-connection-file-transfers'
import type { ChildProcess } from 'node:child_process'
import type {
  Client as SshClient,
  ClientChannel,
  ConnectConfig,
  Prompt,
  PseudoTtyOptions,
  SFTPWrapper,
  ShellOptions
} from 'ssh2'
import type { SshTarget, SshConnectionState, SshConnectionStatus } from '../../../shared/ssh-types'
import {
  getOrcaControlSocketPath,
  isOpenSshConfigBackedTarget,
  type SystemSshBuildArgsOptions
} from '../system-transport/system-ssh-args'
import { removeControlSocketPath } from '../ssh-control-socket'
import { INITIAL_RETRY_ATTEMPTS, INITIAL_RETRY_DELAY_MS, sleep } from './ssh-connection-timing'
import {
  isTransientError,
  isAuthError,
  isPassphraseError,
  isDefiniteSystemSshHostFailure
} from '../ssh-reconnect-error-classification'
import { buildConnectConfig } from './ssh-connect-config'
import { createSshOperationAbortError, type SshExecOptions } from './ssh-exec-options'
import type { SshConnectionCallbacks, SshCredentialKind } from './ssh-connection-callbacks'
import { collectKeyboardInteractiveResponses } from '../ssh-keyboard-interactive'
import { resolveEffectiveProxy, spawnProxyCommand } from '../ssh-proxy-command'
import { resolveWithSshG, type SshResolvedConfig } from '../config/ssh-g-config-resolution'
import {
  createCancelledConnectAttemptError,
  isCancelledConnectAttemptError
} from '../ssh-connect-attempt-cancellation'
import { mayUserSshConfigClaimAlias } from '../config/ssh-config-alias-claim'
import {
  requiresSystemSshForSecurityKey,
  shouldUseSystemSshTransport
} from '../ssh-transport-selection'
import type { FileUploadSession } from '../../providers/filesystem-provider-contract'
import {
  openSshExecChannel,
  openSshSftpChannel,
  openSshShellChannel,
  spawnTrackedSystemSshChannel,
  type SshSessionChannelHost
} from './ssh-connection-session-channels'
import {
  SshConnectionReconnector,
  type SshConnectionReconnectHost
} from './ssh-connection-reconnect'
import { cloneResolvedConfig, waitForSystemSshProbe } from './ssh-system-ssh-probe'
import {
  installSsh2HostKeyVerification,
  readHostKeyTrustSources,
  type HostKeyTrustSources
} from './ssh2-host-key-verification'
import { runSsh2Handshake } from './ssh2-handshake'
import {
  recoverFailedSsh2Attempt,
  type Ssh2CredentialFallbackHost
} from './ssh2-credential-fallback'

/** The sign-in a connection holds in memory, handed to the connection that replaces it. */
export type SshCachedCredentials = { password: string | null; passphrase: string | null }

const SSH_KEYBOARD_INTERACTIVE_MAX_PROMPTS = 8

export class SshConnection {
  private client: SshClient | null = null
  private proxyProcess: ChildProcess | null = null
  private systemCommandChannels = new Set<ClientChannel>()
  private systemOperationAbortController = new AbortController()
  private systemSshResolvedConfig: SshResolvedConfig | null = null
  /** Set by attemptConnect so doSsh2Connect can build a verifier without threading it through. */
  private hostKeyResolvedConfig: SshResolvedConfig | null = null
  /**
   * The trust sources for ONE connect attempt, keyed by its generation.
   *
   * doSsh2Connect runs up to five times per attemptConnect as the credential ladder advances, and
   * each run re-read every known_hosts file, re-read the store, and on the -F path re-scanned the
   * system config. The answer cannot change between rungs of the same attempt — nothing writes these
   * while a handshake is in flight — so it is read once. Keyed by generation rather than cleared,
   * because a superseded attempt must never hand its sources to the live one.
   */
  private hostKeyTrustSources: {
    generation: number
    sources: Promise<HostKeyTrustSources>
  } | null = null
  private systemSshControlMasterDisabledForSession = false
  private systemSshGssapiOnlyForSession = false
  private useSystemSshTransport = false
  private credentialAbortController = new AbortController()
  private readonly pendingSsh2Clients = new Set<SshClient>()
  private state: SshConnectionState
  private callbacks: SshConnectionCallbacks
  private target: SshTarget
  private readonly reconnector: SshConnectionReconnector
  private disposed = false
  private cachedPassphrase: string | null = null
  private cachedPassword: string | null = null
  // Only a sign-in the host accepted may be handed on; a typed or re-asked one is unproven until then.
  private signInVerified = false
  private keyboardInteractiveCancelled = false
  private openCredentialPrompts = 0
  // A rejected cached password must reach the user on the next round.
  private keyboardInteractivePasswordState = { passwordAutoAnswered: false }
  private hostKeyFingerprint: string | undefined
  private connectGeneration = 0

  constructor(
    target: SshTarget,
    callbacks: SshConnectionCallbacks,
    credentials?: SshCachedCredentials
  ) {
    this.target = target
    this.callbacks = callbacks
    this.cachedPassword = credentials?.password ?? null
    this.cachedPassphrase = credentials?.passphrase ?? null
    this.signInVerified = credentials !== undefined
    this.reconnector = new SshConnectionReconnector(this.reconnectHost())
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
  /** True once disconnect() ran: this session is over, and a new connect makes a new connection. */
  isDisposed(): boolean {
    return this.disposed
  }
  getConnectGeneration(): number {
    return this.connectGeneration
  }
  getClient(): SshClient | null {
    return this.client
  }
  /** Work after disconnect() fails with the operation abort error. */
  private assertNotDisposed(): void {
    if (this.disposed) {
      throw createSshOperationAbortError()
    }
  }
  private async runAdmitted<T>(operation: () => Promise<T>): Promise<T> {
    this.assertNotDisposed()
    return operation()
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

  /** The user is answering a prompt, or answered one this connection's own retry has yet to use. */
  isAwaitingCredential(): boolean {
    if (this.openCredentialPrompts > 0) {
      return true
    }
    const retrying = this.state.status === 'connecting' || this.state.status === 'reconnecting'
    return retrying && !this.signInVerified && this.hasCachedCredential()
  }

  /** Null unless the host accepted it, so a wrong password is asked for again, not replayed. */
  getReusableCredentials(): SshCachedCredentials | null {
    if (!this.signInVerified || !this.hasCachedCredential()) {
      return null
    }
    return { password: this.cachedPassword, passphrase: this.cachedPassphrase }
  }

  exec(cmd: string, options?: SshExecOptions): Promise<ClientChannel> {
    return openSshExecChannel(this.sessionChannelHost(), cmd, options)
  }

  /** Interactive login shell over a session channel with pty-req; ssh2 transport only. */
  shell(pty: PseudoTtyOptions, options: ShellOptions = {}): Promise<ClientChannel> {
    return openSshShellChannel(this.sessionChannelHost(), pty, options)
  }

  sftp(options?: AbortSignal | { signal?: AbortSignal }): Promise<SFTPWrapper> {
    return openSshSftpChannel(this.sessionChannelHost(), options)
  }

  private sessionChannelHost(): SshSessionChannelHost {
    return {
      target: this.target,
      client: () => this.client,
      usesSystemSshTransport: () => this.useSystemSshTransport,
      isDisposed: () => this.disposed,
      isConnected: () => this.state.status === 'connected',
      systemSshBuildArgsOptions: () => this.getSystemSshBuildArgsOptions(),
      systemCommandChannels: this.systemCommandChannels
    }
  }

  uploadDirectory(
    localDir: string,
    remoteDir: string,
    options?: SshRemoteFileOptions & { signal?: AbortSignal }
  ): Promise<void> {
    return this.runAdmitted(() =>
      uploadSshDirectory(this.fileTransferHost(), localDir, remoteDir, options)
    )
  }

  downloadFile(
    remotePath: string,
    localPath: string,
    options?: SshRemoteFileOptions
  ): Promise<void> {
    return this.runAdmitted(() =>
      downloadSshFile(this.fileTransferHost(), remotePath, localPath, options)
    )
  }

  async openFileUploadSession(options?: SshRemoteFileOptions): Promise<FileUploadSession> {
    const session = await this.runAdmitted(() =>
      createSshFileUploadSession(this.fileTransferHost(), options)
    )
    return {
      uploadFile: (...args) => this.runAdmitted(() => session.uploadFile(...args)),
      close: () => session.close()
    }
  }

  writeFile(
    remotePath: string,
    contents: string,
    options?: SshRemoteFileOptions & { signal?: AbortSignal }
  ): Promise<void> {
    return this.runAdmitted(() =>
      writeSshFile(this.fileTransferHost(), remotePath, contents, options)
    )
  }

  writeBuffer(
    remotePath: string,
    contents: Buffer,
    options?: SshRemoteFileOptions & { append?: boolean; exclusive?: boolean }
  ): Promise<void> {
    return this.runAdmitted(() =>
      writeSshBuffer(this.fileTransferHost(), remotePath, contents, options)
    )
  }

  private fileTransferHost(): SshFileTransferHost {
    return {
      target: this.target,
      usesSystemSshTransport: () => this.useSystemSshTransport,
      systemOperationSignal: () => this.systemOperationAbortController.signal,
      systemSshBuildArgsOptions: () => this.getSystemSshBuildArgsOptions(),
      sftp: (signal) => this.sftp(signal)
    }
  }

  async connect(): Promise<void> {
    if (this.disposed) {
      throw new Error('Connection disposed')
    }

    let lastError: Error | null = null

    for (let attempt = 0; attempt < INITIAL_RETRY_ATTEMPTS; attempt++) {
      const connectGeneration = ++this.connectGeneration
      try {
        await this.attemptConnect(connectGeneration)
        this.reconnector.markInitialConnect()
        return
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err))

        // Why: a concurrent disconnect() already set 'disconnected'; a cancelled attempt's late error must not overwrite it with auth-failed/error.
        if (this.disposed) {
          throw lastError
        }

        // Why: a newer attempt owns the connection now and publishes its own outcome; retrying here would fight it.
        if (
          !this.isCurrentConnectAttempt(connectGeneration) ||
          isCancelledConnectAttemptError(lastError)
        ) {
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

  // Why: callers claim the generation so their catch can tell their own failure from a superseded one.
  /**
   * A credential prompt, unless this attempt has already been superseded.
   *
   * Gated here rather than at each ladder rung because every rung ends in this one call, and the
   * rungs below the first are exactly where the generation check was missing: a superseded attempt
   * is denied by the verifier WITHOUT a recorded decision (deliberate — a dead attempt must not
   * clobber the live one's outcome), so `isHostKeyVerificationError` reads false and the fallback
   * runs on. The user then gets a passphrase dialog for a connection nobody is waiting on, possibly
   * racing the live attempt's own. Returning undefined drops each rung through to its throw.
   */
  private async requestCredential(
    kind: SshCredentialKind,
    detail: string,
    connectGeneration: number,
    echo?: boolean
  ): Promise<string | null | undefined> {
    if (!this.isCurrentConnectAttempt(connectGeneration)) {
      return undefined
    }
    this.openCredentialPrompts += 1
    try {
      return await this.callbacks.onCredentialRequest?.(
        this.target.id,
        kind,
        detail,
        echo,
        this.credentialAbortController.signal
      )
    } finally {
      this.openCredentialPrompts -= 1
    }
  }

  private async answerKeyboardInteractive(
    hostDetail: string,
    name: string,
    instructions: string,
    prompts: Prompt[],
    connectGeneration: number,
    onPromptStart: () => void
  ): Promise<string[] | null> {
    if (prompts.length === 0 || prompts.length > SSH_KEYBOARD_INTERACTIVE_MAX_PROMPTS) {
      return null
    }
    const heading = [name.trim(), instructions.trim()].filter(Boolean).join('\n')
    const isCurrent = (): boolean => !this.disposed && connectGeneration === this.connectGeneration
    const responses = await collectKeyboardInteractiveResponses(
      {
        targetId: this.target.id,
        hostDetail,
        // Preserve a missing prompter as a capability gap, not a cancellation.
        requestCredential: this.callbacks.onCredentialRequest
          ? async (_targetId, kind, detail, echo) =>
              (await this.requestCredential(kind, detail, connectGeneration, echo)) ?? null
          : undefined,
        getCachedPassword: () => this.cachedPassword,
        setCachedPassword: (value) => {
          if (isCurrent()) {
            this.cachedPassword = value
            this.signInVerified = false
          }
        },
        markCachedPasswordRejected: () => {
          if (isCurrent()) {
            this.signInVerified = false
          }
        },
        markCancelled: () => {
          // A stale prompt must not cancel the current attempt.
          if (isCurrent()) {
            this.keyboardInteractiveCancelled = true
          }
        },
        isCancelled: () => !isCurrent() || this.keyboardInteractiveCancelled,
        state: this.keyboardInteractivePasswordState
      },
      heading,
      prompts,
      onPromptStart
    )
    return isCurrent() ? responses : null
  }

  private async attemptConnect(connectGeneration = ++this.connectGeneration): Promise<void> {
    this.credentialAbortController.abort()
    this.credentialAbortController = new AbortController()
    this.setState('connecting')
    this.killProxy()
    this.keyboardInteractiveCancelled = false
    this.keyboardInteractivePasswordState = { passwordAutoAnswered: false }

    const resolved = await resolveWithSshG(this.target.configHost || this.target.label).catch(
      () => null
    )
    this.hostKeyResolvedConfig = resolved
    const usesConfiguredSystemTransport = shouldUseSystemSshTransport(this.target, resolved)
    const requiresSecurityKeyTransport = usesConfiguredSystemTransport
      ? false
      : await requiresSystemSshForSecurityKey(this.target, resolved)
    if (!this.isCurrentConnectAttempt(connectGeneration)) {
      throw createCancelledConnectAttemptError()
    }
    if (usesConfiguredSystemTransport || requiresSecurityKeyTransport) {
      await this.doSystemSshProbeWithControlMasterRetry(connectGeneration, resolved)
      return
    }
    // Why: ssh2 lacks gssapi-with-mic; GSSAPIAuthentication hosts try Kerberos SSO via system OpenSSH first, then fall through to key/credential auth.
    if (
      isOpenSshConfigBackedTarget(this.target) && resolved
        ? resolved.gssapiAuthentication === true
        : this.target.gssapiAuthentication === true
    ) {
      try {
        await this.doSystemSshProbeWithControlMasterRetry(connectGeneration, resolved, true)
        return
      } catch (probeErr) {
        if (!this.isCurrentConnectAttempt(connectGeneration)) {
          throw probeErr
        }
      }
    }
    // Why: a synchronous spawn throw bypasses the probe's catch, so clear system-transport state here or exec/sftp keep routing through the failed transport.
    this.resetSystemTransport()

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
      await recoverFailedSsh2Attempt(
        err,
        { config, resolved, effectiveProxy },
        this.credentialFallbackHost(connectGeneration)
      )
    }
  }

  private credentialFallbackHost(connectGeneration: number): Ssh2CredentialFallbackHost {
    return {
      target: this.target,
      hasCredentialPrompter: () => Boolean(this.callbacks.onCredentialRequest),
      cachedPassphrase: () => this.cachedPassphrase,
      cachedPassword: () => this.cachedPassword,
      setCachedPassphrase: (value) => {
        this.cachedPassphrase = value
        this.signInVerified = false
      },
      setCachedPassword: (value) => {
        this.cachedPassword = value
        this.signInVerified = false
      },
      isKeyboardInteractiveCancelled: () => this.keyboardInteractiveCancelled,
      isCurrentAttempt: () => this.isCurrentConnectAttempt(connectGeneration),
      connect: (config) => this.doSsh2Connect(config, connectGeneration),
      respawnProxy: (config, proxy) => this.respawnProxy(config, proxy, connectGeneration),
      killProxyIfCurrent: () => this.killProxyIfCurrent(connectGeneration),
      probeSystemSsh: (resolved, gssapiOnly) =>
        this.doSystemSshProbeWithControlMasterRetry(connectGeneration, resolved, gssapiOnly),
      resetSystemTransportIfCurrent: () => this.resetSystemTransportIfCurrent(connectGeneration),
      requestCredential: (kind, detail) => this.requestCredential(kind, detail, connectGeneration)
    }
  }

  reconnect(): Promise<void> {
    return this.reconnector.reconnect()
  }

  /** Wake or network return; see SshConnectionReconnector.retryAfterNetworkReturn. */
  retryAfterNetworkReturn(nowMs = Date.now()): boolean {
    return this.reconnector.retryAfterNetworkReturn(nowMs)
  }

  private reconnectHost(): SshConnectionReconnectHost {
    return {
      targetId: this.target.id,
      label: this.target.label,
      isDisposed: () => this.disposed,
      status: () => this.state.status,
      isAwaitingCredential: () => this.isAwaitingCredential(),
      claimGeneration: () => ++this.connectGeneration,
      currentGeneration: () => this.connectGeneration,
      isCurrentAttempt: (connectGeneration) => this.isCurrentConnectAttempt(connectGeneration),
      attemptConnect: (connectGeneration) => this.attemptConnect(connectGeneration),
      closeTransportsForReconnect: () => this.closeTransportsForReconnect(),
      setReconnectAttempt: (attempt) => {
        this.state.reconnectAttempt = attempt
      },
      setState: (status, error) => this.setState(status, error)
    }
  }

  private async doSystemSshProbe(connectGeneration: number): Promise<void> {
    if (!this.isCurrentConnectAttempt(connectGeneration)) {
      throw createCancelledConnectAttemptError()
    }
    this.useSystemSshTransport = true
    this.client = null
    this.killProxy()

    // Why: this probe runs before remote platform detection; a raw echo works under POSIX shells, cmd.exe, and PowerShell, but `/bin/sh` wrapping does not.
    const channel = spawnTrackedSystemSshChannel(
      this.sessionChannelHost(),
      'echo ORCA-SYSTEM-SSH-OK',
      {
        wrapCommand: false
      }
    )
    try {
      await waitForSystemSshProbe(channel, {
        target: this.target,
        resolvedConfig: () => this.systemSshResolvedConfig,
        isCurrentAttempt: () => this.isCurrentConnectAttempt(connectGeneration),
        onConnected: () => this.setState('connected'),
        untrackChannel: (probeChannel) => this.systemCommandChannels.delete(probeChannel)
      })
    } catch (err) {
      // Why: a superseded probe closes late; its cleanup must not strip the replacement's transport.
      if (this.isCurrentConnectAttempt(connectGeneration)) {
        this.useSystemSshTransport = false
        this.systemSshResolvedConfig = null
      }
      throw err
    }
  }

  private async doSystemSshProbeWithControlMasterRetry(
    connectGeneration: number,
    resolved: SshResolvedConfig | null,
    gssapiOnly = false
  ): Promise<void> {
    if (!this.isCurrentConnectAttempt(connectGeneration)) {
      throw createCancelledConnectAttemptError()
    }
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
      if (!controlPath || !this.isCurrentConnectAttempt(connectGeneration)) {
        throw err
      }
      removeControlSocketPath(controlPath)
      // Why: a timeout retry doubles the ladder step, but a stuck master can cause the first timeout.
      if (
        isDefiniteSystemSshHostFailure(err) ||
        (err instanceof Error && (isAuthError(err) || isPassphraseError(err)))
      ) {
        throw err
      }
      this.systemSshResolvedConfig = cloneResolvedConfig(resolved)
      this.systemSshControlMasterDisabledForSession = true
      try {
        await this.doSystemSshProbe(connectGeneration)
      } catch (retryErr) {
        if (this.isCurrentConnectAttempt(connectGeneration)) {
          this.systemSshControlMasterDisabledForSession = false
        }
        throw retryErr
      }
    }
  }

  private isCurrentConnectAttempt(connectGeneration: number): boolean {
    return !this.disposed && connectGeneration === this.connectGeneration
  }

  getSystemSshBuildArgsOptions(): SystemSshBuildArgsOptions {
    const options: SystemSshBuildArgsOptions = {}
    if (this.systemSshResolvedConfig) {
      options.resolvedConfig = this.systemSshResolvedConfig
    }
    // Why here and not inside buildSshArgs: the verdict reads ~/.ssh/config, and an arg builder
    // that consults the filesystem answers differently on every machine, tests included.
    if (this.target.configHost && !mayUserSshConfigClaimAlias(this.target.configHost)) {
      options.aliasClaimedByConfig = false
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
    proxy: ReturnType<typeof resolveEffectiveProxy> | null | undefined,
    connectGeneration: number
  ): void {
    if (!proxy) {
      return
    }
    // Why: this.proxyProcess belongs to whichever attempt is current; a superseded one must not kill it.
    if (!this.isCurrentConnectAttempt(connectGeneration)) {
      throw createCancelledConnectAttemptError()
    }
    this.proxyProcess?.kill()
    const p = spawnProxyCommand(proxy, config.host!, config.port!, config.username!)
    this.proxyProcess = p.process
    config.sock = p.sock
  }

  /** Reads known_hosts, our store and the site policy once per connect attempt. */
  private loadHostKeyTrustSources(
    connectGeneration: number,
    hostKeyResolved: SshResolvedConfig | null,
    sshGSuppressedSiteConfig: boolean
  ): Promise<HostKeyTrustSources> {
    if (this.hostKeyTrustSources?.generation === connectGeneration) {
      return this.hostKeyTrustSources.sources
    }
    const sources = readHostKeyTrustSources(hostKeyResolved, sshGSuppressedSiteConfig)
    this.hostKeyTrustSources = { generation: connectGeneration, sources }
    return sources
  }

  private async doSsh2Connect(config: ConnectConfig, connectGeneration: number): Promise<void> {
    const hostKeyResolved = this.hostKeyResolvedConfig
    const isCurrentAttempt = (): boolean => this.isCurrentConnectAttempt(connectGeneration)
    const verdict = await installSsh2HostKeyVerification(config, {
      target: this.target,
      hostKeyResolved,
      loadTrustSources: (sshGSuppressedSiteConfig) =>
        this.loadHostKeyTrustSources(connectGeneration, hostKeyResolved, sshGSuppressedSiteConfig),
      isCurrentAttempt,
      onAcceptedFingerprint: (fingerprint) => {
        this.hostKeyFingerprint = fingerprint
      }
    })
    return runSsh2Handshake(config, {
      label: this.target.label,
      pendingClients: this.pendingSsh2Clients,
      isCurrentAttempt,
      isNewestGeneration: () => connectGeneration === this.connectGeneration,
      isDisposed: () => this.disposed,
      isKeyboardInteractiveCancelled: () => this.keyboardInteractiveCancelled,
      answerKeyboardInteractive: (hostDetail, name, instructions, prompts, onPromptStart) =>
        this.answerKeyboardInteractive(
          hostDetail,
          name,
          instructions,
          prompts,
          connectGeneration,
          onPromptStart
        ),
      hostKeyRejection: () => verdict.rejection,
      adoptClient: (client) => {
        this.client = client
        this.proxyProcess = null
        this.setupDisconnectHandler(client)
      },
      onConnected: () => this.setState('connected')
    })
  }

  // Why: guard on identity so a late event from the old client can't null out a successful reconnect.
  private setupDisconnectHandler(client: SshClient): void {
    const onDrop = () => {
      if (this.disposed || this.client !== client) {
        return
      }
      this.client = null
      this.reconnector.scheduleReconnect()
    }
    client.on('end', onDrop)
    client.on('close', onDrop)
    client.on('error', (err) => {
      if (this.disposed || this.client !== client) {
        return
      }
      console.warn(`[ssh] Connection error for ${this.target.label}: ${err.message}`)
      this.client = null
      this.reconnector.scheduleReconnect()
    })
  }

  private closePendingSsh2Clients(): void {
    for (const client of this.pendingSsh2Clients) {
      try {
        client.end()
        client.destroy()
      } catch {
        // The startup socket may already be closing.
      }
    }
    this.pendingSsh2Clients.clear()
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
    this.credentialAbortController.abort()
    this.credentialAbortController = new AbortController()
    this.closeSessionTransports()
  }

  /** Teardown shared by reconnect and disconnect, after each has closed the ssh2 client. */
  private closeSessionTransports(): void {
    this.closePendingSsh2Clients()
    this.killProxy()
    this.systemOperationAbortController.abort()
    this.systemOperationAbortController = new AbortController()
    for (const channel of this.systemCommandChannels) {
      channel.close()
    }
    this.systemCommandChannels.clear()
    this.resetSystemTransport()
  }

  private resetSystemTransportIfCurrent(connectGeneration: number): void {
    if (this.isCurrentConnectAttempt(connectGeneration)) {
      this.resetSystemTransport()
    }
  }

  private resetSystemTransport(): void {
    this.systemSshResolvedConfig = null
    this.systemSshControlMasterDisabledForSession = false
    this.systemSshGssapiOnlyForSession = false
    this.useSystemSshTransport = false
  }

  private killProxyIfCurrent(connectGeneration: number): void {
    if (this.isCurrentConnectAttempt(connectGeneration)) {
      this.killProxy()
    }
  }

  private killProxy(): void {
    this.proxyProcess?.kill()
    this.proxyProcess = null
  }

  /** `quiet` tears down without publishing 'disconnected', keeping a failed startup's error. */
  async disconnect(options?: { quiet?: boolean }): Promise<void> {
    this.disposed = true
    this.connectGeneration += 1
    this.reconnector.cancelTimer()
    this.cachedPassphrase = null
    this.cachedPassword = null
    this.credentialAbortController.abort()
    this.client?.end()
    this.client = null
    this.closeSessionTransports()
    this.reconnector.resetLadder()
    if (!options?.quiet) {
      this.setState('disconnected')
    }
  }

  private setState(status: SshConnectionStatus, error?: string): void {
    if (status === 'auth-failed' || status === 'connected') {
      this.signInVerified = status === 'connected'
    }
    this.state = {
      ...this.state,
      status,
      error: error ?? null,
      supportsFolderDownload: status === 'connected' && !this.useSystemSshTransport
    }
    this.callbacks.onStateChange(this.target.id, { ...this.state })
  }
}

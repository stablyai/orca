/* eslint-disable max-lines -- Why: SSH connection lifecycle, credential retries, reconnect policy, and transport fallback are intentionally co-located so state transitions stay auditable in one file. */
import * as net from 'node:net'
import { Client as SshClient } from 'ssh2'
import { sshProxyRouteDigest, type SshConnectionDestination } from './ssh-connection-destination'
import {
  SshConnectionWorkLedger,
  type SshConnectionWorkChannel
} from './ssh-connection-work-ledger'
import { SshTransportCloseLedger } from './ssh-transport-close-ledger'
import { SshTransportClosureSubscribers } from './ssh-connection-transport-closure'
import { disconnectAndAwaitSshTransportClose } from './ssh-connection-close-drain'
import { openTrackedSshUploadSession } from './ssh-upload-session-lifetime'
import {
  createSshFileUploadSession,
  downloadSshFile,
  uploadSshDirectory,
  writeSshBuffer,
  writeSshFile,
  type SshFileTransferHost,
  type SshRemoteFileOptions
} from './ssh-connection-file-transfers'
import {
  assertSshForwardClient,
  assertSshStreamLocalForwardAllowed,
  forwardTrackedSshChannel,
  forwardTrackedSshStreamLocalChannel
} from './ssh-forward-channel-lifetime'
import {
  openTrackedSshSocket,
  trackSshConnectionChannelLifetime
} from './ssh-connection-channel-lifetime'
import type { ChildProcess } from 'node:child_process'
import type {
  ClientChannel,
  ConnectConfig,
  KeyboardInteractiveCallback,
  Prompt,
  PseudoTtyOptions,
  SFTPWrapper,
  ShellOptions
} from 'ssh2'
import type { SshTarget, SshConnectionState, SshConnectionStatus } from '../../shared/ssh-types'
import {
  getOrcaControlSocketPath,
  spawnSystemSsh,
  spawnSystemSshCommand,
  type SystemSshBuildArgsOptions,
  type SystemSshProcess
} from './ssh-system-fallback'
import { resolveWithSshG, type SshResolvedConfig } from './ssh-config-parser'
import { removeControlSocketPath } from './ssh-control-socket'
import { isOpenSshConfigBackedTarget } from './system-ssh-args'
import {
  INITIAL_RETRY_ATTEMPTS,
  INITIAL_RETRY_DELAY_MS,
  RECONNECT_BACKOFF_MS,
  CONNECT_TIMEOUT_MS,
  SSH_CREDENTIAL_TIMEOUT_MS,
  isTransientError,
  isAuthError,
  isAgentFallbackError,
  isSystemSshFallbackError,
  isGssapiSystemSshFallbackCandidate,
  isPassphraseError,
  sleep,
  buildConnectConfig,
  wrapRemoteCommandForPosixShell,
  createSshOperationAbortError,
  type SshExecOptions,
  type SshConnectionCallbacks,
  type SshCredentialKind
} from './ssh-connection-utils'
import { collectKeyboardInteractiveResponses } from './ssh-keyboard-interactive'
import { resolveEffectiveProxy, spawnProxyCommand } from './ssh-proxy-command'
import {
  createHostKeyVerifier,
  DEFAULT_SERVER_HOST_KEY_ALGORITHMS,
  orderServerHostKeyAlgorithms
} from './ssh-host-key-verifier'
import { HostKeyVerificationError, isHostKeyVerificationError } from './ssh-host-key-decision'
import { siteConfigMayRestrictHostKeys, sshGArgsForHost } from './ssh-g-config-resolution'
import {
  boundSshHostKeyStoreFile,
  loadTrustedHostKeys,
  matchTrustedHostKeys,
  storedKeyTypesForEndpoint,
  trustHostKey
} from './ssh-host-key-store'
import {
  loadKnownHostsEvidence,
  resolveKnownHostsFiles,
  resolveKnownHostsLookupHost
} from './ssh-known-hosts-source'
import {
  createCancelledConnectAttemptError,
  isCancelledConnectAttemptError
} from './ssh-connect-attempt-cancellation'
import {
  isDefiniteSystemSshHostFailure,
  isTransientReconnectError
} from './ssh-reconnect-error-classification'
import { SshReconnectLadder } from './ssh-reconnect-ladder'
import { mayUserSshConfigClaimAlias } from './ssh-config-alias-claim'
import { getPassphrasePrivateKeyPath } from './ssh-private-key-authentication'
import {
  requiresSystemSshForSecurityKey,
  shouldUseSystemSshTransport
} from './ssh-transport-selection'
import type { FileUploadSession } from '../providers/types'
import { openSshSessionChannelWithRetry, waitForSshChannelOpen } from './ssh-channel-open'
import { withTimeout } from '../../shared/promise-timeout-fallback'
export type { SshConnectionCallbacks } from './ssh-connection-utils'

type HostKeyTrustSources = {
  /** Whether the system-wide ssh_config could be restricting host keys; doubt reads as true. */
  siteMayRestrict: boolean
  knownHostsEvidence: Awaited<ReturnType<typeof loadKnownHostsEvidence>>
  trustedHostKeys: Awaited<ReturnType<typeof loadTrustedHostKeys>>
}

/** Bounds the trust-source reads that run before the handshake, which nothing else times out. */
const HOST_KEY_SOURCE_READ_TIMEOUT_MS = 5_000
// Counts every INFO_REQUEST of the handshake, so it must cover each partial-success stage the auth
// queue will answer (MAX_PARTIAL_SUCCESS_STAGES) times the rounds a PAM stack spends per stage.
const SSH_KEYBOARD_INTERACTIVE_MAX_ROUNDS = 8
const SSH_KEYBOARD_INTERACTIVE_READY_TIMEOUT_MS = SSH_CREDENTIAL_TIMEOUT_MS + 5_000
const SSH_KEYBOARD_INTERACTIVE_MAX_PROMPTS = 8

function cloneResolvedConfig(config: SshResolvedConfig | null): SshResolvedConfig | null {
  if (!config) {
    return null
  }
  // Every array field needs its own copy — a shared reference lets one connection's clone mutate
  // another's view of which files were consulted.
  return {
    ...config,
    identityFile: [...config.identityFile],
    userKnownHostsFiles: [...config.userKnownHostsFiles],
    globalKnownHostsFiles: [...config.globalKnownHostsFiles]
  }
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

  const effectiveUser = (
    isOpenSshConfigBackedTarget(target) && resolvedConfig
      ? resolvedConfig.user?.trim() || target.username?.trim()
      : target.username?.trim() || resolvedConfig?.user?.trim()
  )?.toLowerCase()
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
  // Local lifetime evidence only: a closed channel or client never proves a remote process exited.
  private readonly workLedger = new SshConnectionWorkLedger(
    () => this.transportClosure.notify(),
    () => {
      if (this.disposed) {
        throw createSshOperationAbortError()
      }
    }
  )
  private readonly transportCloseLedger = new SshTransportCloseLedger(() =>
    this.transportClosure.notify()
  )
  private readonly transportClosure = new SshTransportClosureSubscribers(
    () =>
      this.disposed &&
      this.state.status === 'disconnected' &&
      this.activeConnectCalls === 0 &&
      this.pendingSsh2Clients.size === 0 &&
      !this.unprovenStartupTransport &&
      this.transportCloseLedger.isClosed() &&
      this.workLedger.isDrained()
  )
  private readonly automaticReconnect: boolean
  // Set once drained for close; no reconnect or new transport may replace the fenced one.
  private resetConnectionFenced = false
  private activeConnectCalls = 0
  // Sticky: a system-ssh child's transport closure cannot be proven from here.
  private unprovenStartupTransport = false
  private executionDestination:
    | { client: SshClient; generation: number; destination: SshConnectionDestination }
    | undefined
  private state: SshConnectionState
  private callbacks: SshConnectionCallbacks
  private target: SshTarget
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private readonly reconnectLadder = new SshReconnectLadder()
  private disposed = false
  private cachedPassphrase: string | null = null
  private cachedPassword: string | null = null
  private keyboardInteractiveCancelled = false
  // A rejected cached password must reach the user on the next round.
  private keyboardInteractivePasswordState = { passwordAutoAnswered: false }
  private hostKeyFingerprint: string | undefined
  private connectGeneration = 0

  constructor(
    target: SshTarget,
    callbacks: SshConnectionCallbacks,
    options: { automaticReconnect?: boolean } = {}
  ) {
    this.automaticReconnect = options.automaticReconnect !== false
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
  getConnectGeneration(): number {
    return this.connectGeneration
  }
  /** Equals the connect generation; later slices name it by the transport it identifies. */
  getTransportGeneration(): number {
    return this.connectGeneration
  }
  /** The ssh2 destination proven by the current handshake; undefined on system SSH or when stale. */
  getExecutionDestination(): SshConnectionDestination | undefined {
    const captured = this.executionDestination
    return !this.disposed &&
      !this.useSystemSshTransport &&
      this.state.status === 'connected' &&
      captured?.client === this.client &&
      captured?.generation === this.connectGeneration
      ? captured.destination
      : undefined
  }
  subscribeTransportClosure(onClosed: () => void): () => void {
    return this.transportClosure.subscribe(onClosed)
  }
  getClient(): SshClient | null {
    return this.client
  }
  prepareForwardRoute<T>(prepare: () => Promise<T>): Promise<T> {
    return this.workLedger.run(prepare)
  }
  openForwardSocket<T extends NodeJS.EventEmitter>(open: () => T): T {
    return openTrackedSshSocket(this.workLedger, open, this.reportUnhandledChannelError('socket'))
  }
  forwardOut(
    client: SshClient,
    localSocket: SshConnectionWorkChannel,
    ...args: Parameters<SshClient['forwardOut']>
  ): void {
    assertSshForwardClient(this.client, client)
    const report = this.reportUnhandledChannelError('forward')
    forwardTrackedSshChannel(this.workLedger, client, localSocket, report, ...args)
  }
  forwardStreamLocal(
    client: SshClient,
    ...args: Parameters<SshClient['openssh_forwardOutStreamLocal']>
  ): void {
    assertSshForwardClient(this.client, client)
    const usable =
      !this.disposed && !this.useSystemSshTransport && this.state.status === 'connected'
    assertSshStreamLocalForwardAllowed(usable, args[0])
    const report = this.reportUnhandledChannelError('stream-local forward')
    forwardTrackedSshStreamLocalChannel(this.workLedger, client, report, ...args)
  }
  /** Names the connection and channel kind when a tracked channel's error has no other handler. */
  private reportUnhandledChannelError(kind: string): (error: Error) => void {
    return (error) =>
      console.warn(
        `[ssh] Unhandled ${kind} channel error for ${this.target.label}: ${error.message}`
      )
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

  exec(cmd: string, options?: SshExecOptions): Promise<ClientChannel> {
    return this.workLedger.run(() => this.execUntracked(cmd, options))
  }

  private async execUntracked(cmd: string, options?: SshExecOptions): Promise<ClientChannel> {
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
    return openSshSessionChannelWithRetry(
      () =>
        waitForSshChannelOpen(
          this.workLedger.beginChannelOpen(),
          'SSH exec channel timed out',
          (callback) => client.exec(remoteCommand, callback),
          (channel) => channel.close(),
          options?.signal,
          true,
          this.reportUnhandledChannelError('exec')
        ),
      options?.signal
    )
  }

  /** Interactive login shell over a session channel with pty-req; ssh2 transport only. */
  shell(pty: PseudoTtyOptions, options: ShellOptions = {}): Promise<ClientChannel> {
    // Plain SSH mode's terminals must drain with the rest of this connection's work.
    return this.workLedger.run(() => this.shellUntracked(pty, options))
  }

  private async shellUntracked(
    pty: PseudoTtyOptions,
    options: ShellOptions
  ): Promise<ClientChannel> {
    if (this.useSystemSshTransport) {
      throw new Error('Interactive SSH shells are not available when using system SSH transport')
    }
    if (!this.client) {
      throw new Error('Not connected')
    }
    const client = this.client
    return openSshSessionChannelWithRetry(() =>
      waitForSshChannelOpen(
        this.workLedger.beginChannelOpen(),
        'SSH shell channel timed out',
        (callback) => client.shell(pty, options, callback),
        (channel) => channel.close(),
        undefined,
        false,
        this.reportUnhandledChannelError('shell')
      )
    )
  }

  sftp(options?: AbortSignal | { signal?: AbortSignal }): Promise<SFTPWrapper> {
    return this.workLedger.run(() => this.sftpUntracked(options))
  }

  private async sftpUntracked(
    options?: AbortSignal | { signal?: AbortSignal }
  ): Promise<SFTPWrapper> {
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
    return openSshSessionChannelWithRetry(
      () =>
        waitForSshChannelOpen(
          this.workLedger.beginChannelOpen(),
          'SSH SFTP channel timed out',
          (callback) => client.sftp(callback),
          (sftp) => sftp.end(),
          signal,
          false,
          this.reportUnhandledChannelError('sftp')
        ),
      signal
    )
  }

  uploadDirectory(
    localDir: string,
    remoteDir: string,
    options?: SshRemoteFileOptions & { signal?: AbortSignal }
  ): Promise<void> {
    return this.workLedger.run(() =>
      uploadSshDirectory(this.fileTransferHost(), localDir, remoteDir, options)
    )
  }

  downloadFile(
    remotePath: string,
    localPath: string,
    options?: SshRemoteFileOptions
  ): Promise<void> {
    return this.workLedger.run(() =>
      downloadSshFile(this.fileTransferHost(), remotePath, localPath, options)
    )
  }

  openFileUploadSession(options?: SshRemoteFileOptions): Promise<FileUploadSession> {
    return openTrackedSshUploadSession(this.workLedger, () =>
      createSshFileUploadSession(this.fileTransferHost(), options)
    )
  }

  writeFile(
    remotePath: string,
    contents: string,
    options?: SshRemoteFileOptions & { signal?: AbortSignal }
  ): Promise<void> {
    return this.workLedger.run(() =>
      writeSshFile(this.fileTransferHost(), remotePath, contents, options)
    )
  }

  writeBuffer(
    remotePath: string,
    contents: Buffer,
    options?: SshRemoteFileOptions & { append?: boolean; exclusive?: boolean }
  ): Promise<void> {
    return this.workLedger.run(() =>
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
    this.activeConnectCalls++
    try {
      await this.connectInitialAttempts()
    } finally {
      this.activeConnectCalls--
      this.transportClosure.notify()
    }
  }

  private assertConnectionReplacementAllowed(): void {
    if (this.resetConnectionFenced) {
      throw new Error('ssh_connection_reset_replacement_refused')
    }
  }

  private async connectInitialAttempts(): Promise<void> {
    this.assertConnectionReplacementAllowed()
    if (this.disposed) {
      throw new Error('Connection disposed')
    }

    let lastError: Error | null = null

    for (let attempt = 0; attempt < INITIAL_RETRY_ATTEMPTS; attempt++) {
      this.assertConnectionReplacementAllowed()
      const connectGeneration = ++this.connectGeneration
      try {
        await this.attemptConnect(connectGeneration)
        this.reconnectLadder.reset()
        this.reconnectLadder.markConnected(Date.now())
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
    if (this.disposed || connectGeneration !== this.connectGeneration) {
      return undefined
    }
    return this.callbacks.onCredentialRequest?.(
      this.target.id,
      kind,
      detail,
      echo,
      this.credentialAbortController.signal
    )
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
    this.executionDestination = undefined
    this.credentialAbortController.abort()
    this.credentialAbortController = new AbortController()
    this.setState('connecting')
    this.proxyProcess?.kill()
    this.proxyProcess = null
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
      throw this.createCancelledConnectAttemptError()
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
    const proxyRouteDigest = sshProxyRouteDigest(effectiveProxy)
    if (effectiveProxy) {
      const proxy = spawnProxyCommand(effectiveProxy, config.host!, config.port!, config.username!)
      this.transportCloseLedger.track(proxy.process)
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
      await this.doSsh2Connect(config, connectGeneration, proxyRouteDigest)
    } catch (err) {
      if (!(err instanceof Error)) {
        this.proxyProcess?.kill()
        this.proxyProcess = null
        throw err
      }

      // Why generation and not the error: a superseded attempt's host key denial is deliberately
      // NOT recorded — the verifier withholds it so a dead attempt cannot clobber the live one's
      // outcome — so nothing about the error identifies it, and ssh2's generic handshake failure
      // reads as an ordinary fault. Everything below either offers a credential or probes another
      // transport, and doing that for a connection nobody is waiting on can put a passphrase prompt
      // in front of a host we just refused. Checking the generation catches it whatever the error
      // turned out to be, and leaves what connect() rejects with unchanged.
      if (this.disposed || connectGeneration !== this.connectGeneration) {
        this.proxyProcess?.kill()
        this.proxyProcess = null
        throw err
      }

      // Why first: everything below this line either offers a credential or retries on another
      // transport. We have just decided this host may not be the one it claims to be, so prompting
      // would collect the user's passphrase or password on its behalf, and the system-ssh probe
      // would connect anyway whenever the disagreement is with our own store rather than
      // known_hosts. A denied key is final for this attempt.
      if (isHostKeyVerificationError(err)) {
        this.proxyProcess?.kill()
        this.proxyProcess = null
        throw err
      }

      // Cancellation must stop the credential and transport fallback chain.
      if (this.keyboardInteractiveCancelled) {
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
            await this.doSsh2Connect(keyConfig, connectGeneration, proxyRouteDigest)
            return
          } catch (keyErr) {
            // Same reason as above: the retry re-runs the handshake, so it can be the attempt that
            // denies the key, and the passphrase prompt is directly below.
            if (!(keyErr instanceof Error) || isHostKeyVerificationError(keyErr)) {
              this.proxyProcess?.kill()
              this.proxyProcess = null
              throw keyErr
            }
            // Key fallback must honor the same cancellation boundary.
            if (this.keyboardInteractiveCancelled) {
              this.proxyProcess?.kill()
              this.proxyProcess = null
              throw keyErr
            }
            authError = keyErr
            const passphraseKeyPath = getPassphrasePrivateKeyPath(keyConfig)
            // Why: with GSSAPI enabled, let the reactive system-ssh probe try a Kerberos ticket before prompting for the passphrase; the prompt still runs if it fails.
            if (
              (isPassphraseError(authError) || passphraseKeyPath) &&
              !this.cachedPassphrase &&
              !isGssapiSystemSshFallbackCandidate(authError, this.target, resolved)
            ) {
              passphrasePromptHandled = true
              const detail =
                passphraseKeyPath ||
                this.target.identityFile ||
                resolved?.identityFile?.[0] ||
                '(unknown)'
              const val = await this.requestCredential('passphrase', detail, connectGeneration)
              if (val) {
                this.cachedPassphrase = val
                keyConfig.passphrase = val
                this.respawnProxy(keyConfig, effectiveProxy)
                await this.doSsh2Connect(keyConfig, connectGeneration, proxyRouteDigest)
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
      const passphraseKeyPath = getPassphrasePrivateKeyPath(credentialRetryConfig)
      if (
        (isPassphraseError(authError) || passphraseKeyPath) &&
        !this.cachedPassphrase &&
        !passphrasePromptHandled
      ) {
        const detail =
          passphraseKeyPath ||
          this.target.identityFile ||
          resolved?.identityFile?.[0] ||
          '(unknown)'
        const val = await this.requestCredential('passphrase', detail, connectGeneration)
        if (val) {
          this.cachedPassphrase = val
          credentialRetryConfig.passphrase = val
          this.respawnProxy(credentialRetryConfig, effectiveProxy)
          await this.doSsh2Connect(credentialRetryConfig, connectGeneration, proxyRouteDigest)
          return
        }
      }
      // Why: an agent socket failure can still be recovered by password auth, but the retry must use the no-agent config selected above.
      if (isAgentFallbackError(authError) && !this.cachedPassword) {
        const val = await this.requestCredential(
          'password',
          config.host || this.target.label,
          connectGeneration
        )
        if (val) {
          this.cachedPassword = val
          credentialRetryConfig.password = val
          this.respawnProxy(credentialRetryConfig, effectiveProxy)
          await this.doSsh2Connect(credentialRetryConfig, connectGeneration, proxyRouteDigest)
          return
        }
      }
      this.proxyProcess?.kill()
      this.proxyProcess = null
      throw authError
    }
  }

  async reconnect(): Promise<void> {
    this.assertConnectionReplacementAllowed()
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
    this.reconnectLadder.reset()
    this.setState('reconnecting')
    await this.runReconnectAttempt()
  }

  private async doSystemSshProbe(connectGeneration: number): Promise<void> {
    this.unprovenStartupTransport = true
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
              reject(this.createCancelledConnectAttemptError())
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
      if (
        isDefiniteSystemSshHostFailure(err) ||
        (err instanceof Error && (isAuthError(err) || isPassphraseError(err)))
      ) {
        throw err
      }
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
    this.unprovenStartupTransport = true
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
    return createCancelledConnectAttemptError()
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
    const work = this.workLedger.beginChannelOpen()
    let channel: ClientChannel
    try {
      channel =
        commandOptions === undefined
          ? spawnSystemSshCommand(this.target, command)
          : spawnSystemSshCommand(this.target, command, commandOptions)
      trackSshConnectionChannelLifetime(work, channel, this.reportUnhandledChannelError('command'))
    } catch (error) {
      work.close(error)
      throw error
    }
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
    proxy: ReturnType<typeof resolveEffectiveProxy> | null | undefined
  ): void {
    if (!proxy) {
      return
    }
    this.proxyProcess?.kill()
    const p = spawnProxyCommand(proxy, config.host!, config.port!, config.username!)
    this.transportCloseLedger.track(p.process)
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
    const sources = (async (): Promise<HostKeyTrustSources> => {
      const [siteMayRestrict, knownHostsEvidence, trustedHostKeys] = await Promise.all([
        // Doubt wins on timeout for the same reason it wins on an unreadable file.
        sshGSuppressedSiteConfig
          ? withTimeout(siteConfigMayRestrictHostKeys(), HOST_KEY_SOURCE_READ_TIMEOUT_MS, true)
          : Promise.resolve(false),
        // Why bounded: these reads sit AHEAD of client.connect, and readyTimeout only covers the
        // handshake — nothing else wraps attemptConnect. A home directory on a stalled NFS or SMB
        // mount makes readFile hang indefinitely, which left the connection wedged in `connecting`
        // with no ladder entry and no recovery. The fallback is the one an unreadable file already
        // produces: evidence withheld, so we connect as ssh does but record nothing, rather than the
        // far worse "no hosts known" that would let a changed key through as first contact.
        withTimeout(
          resolveKnownHostsFiles(hostKeyResolved).then(loadKnownHostsEvidence),
          HOST_KEY_SOURCE_READ_TIMEOUT_MS,
          { entries: [], unreadableFileCount: 1 }
        ),
        // The catch sits INSIDE the timeout on purpose: withTimeout absorbs rejections into its
        // fallback, so wrapping the other way round would silently swallow the warning below — the
        // one signal that the store is unwired rather than merely slow.
        withTimeout(
          loadTrustedHostKeys().catch((err) => {
            // Losing our own records is not a security regression: known_hosts is still consulted,
            // so a changed key is still refused. A host trusted only by us degrades to first contact
            // and is re-recorded, which reaches the same decision. Loud because it means the store
            // is unwired.
            console.warn('[ssh] host key store unavailable; falling back to known_hosts only:', err)
            return []
          }),
          HOST_KEY_SOURCE_READ_TIMEOUT_MS,
          []
        )
      ])
      return { siteMayRestrict, knownHostsEvidence, trustedHostKeys }
    })()
    this.hostKeyTrustSources = { generation: connectGeneration, sources }
    return sources
  }

  private async doSsh2Connect(
    config: ConnectConfig,
    connectGeneration: number,
    proxyRouteDigest: string
  ): Promise<void> {
    const endpoint = {
      host: config.host ?? '',
      port: config.port ?? 22,
      username: config.username ?? ''
    }
    const hostKeyResolved = this.hostKeyResolvedConfig
    const { host: hostKeyLookupHost, isHostKeyAlias } = resolveKnownHostsLookupHost(
      hostKeyResolved,
      config.host ?? ''
    )
    // `-F` suppresses /etc/ssh/ssh_config, so a site-wide StrictHostKeyChecking is invisible to us
    // on that path. Joined below with the other way a source can go silent: an unreadable file.
    //
    // Gated on `ssh -G` having actually produced something. sshGArgsForHost only reports which args
    // WOULD be used, so without this a machine where ssh is missing, broken or timed out was judged
    // by whether it happens to have a ~/.ssh/config — incoherently, since the same broken machine
    // WITHOUT one was fully permissive. The flag is a claim about a config file we could not read,
    // and when ssh never ran there is no such claim to make.
    const sshGSuppressedSiteConfig =
      hostKeyResolved !== null &&
      sshGArgsForHost(this.target.configHost || this.target.label).includes('-F')
    // Being blind to the site policy is only a reason to refuse if the site config could actually be
    // setting one. ssh cannot answer that — `-F` excludes the system config as surely as the user's,
    // and `-F /dev/null` reports built-in defaults rather than inverting the exclusion — so the file
    // is read instead, conservatively: any doubt keeps the refusal.
    const { siteMayRestrict, knownHostsEvidence, trustedHostKeys } =
      await this.loadHostKeyTrustSources(
        connectGeneration,
        hostKeyResolved,
        sshGSuppressedSiteConfig
      )
    const siteConfigSuppressed = siteMayRestrict
    const knownHostsEntries = knownHostsEvidence.entries
    // Null means ssh2's own list was unreadable, so there is nothing safe to reorder against and
    // ssh2 keeps proposing whatever it supports.
    const serverHostKeyOrder = DEFAULT_SERVER_HOST_KEY_ALGORITHMS
      ? orderServerHostKeyAlgorithms(
          knownHostsEntries,
          hostKeyLookupHost,
          config.port ?? 22,
          DEFAULT_SERVER_HOST_KEY_ALGORITHMS,
          storedKeyTypesForEndpoint(trustedHostKeys, hostKeyLookupHost, config.port ?? 22),
          isHostKeyAlias
        )
      : undefined
    return new Promise<void>((resolve, reject) => {
      const client = new SshClient()
      this.transportCloseLedger.track(client)
      this.pendingSsh2Clients.add(client)
      let settled = false
      let startupTimer: ReturnType<typeof setTimeout> | null = null
      let keyboardInteractiveRounds = 0
      const clearStartupTimer = (): void => {
        if (startupTimer) {
          clearTimeout(startupTimer)
          startupTimer = null
        }
      }
      const rearmStartupTimer = (timeoutMs: number): void => {
        clearStartupTimer()
        startupTimer = setTimeout(() => {
          const error = new Error('Timed out while waiting for SSH authentication')
          Object.assign(error, { level: 'client-timeout' })
          onStartupError(error)
        }, timeoutMs)
      }
      // Local to this attempt: an instance field would let a superseded attempt's rejection replace
      // the live attempt's error, and substituting a new Error drops ssh2's `code`, so a transient
      // ECONNRESET would stop being classified as retryable.
      let hostKeyRejection: HostKeyVerificationError | null = null
      let acceptedFingerprint: string | undefined

      // Why the fingerprint is still recorded: the relay uses the negotiated server key to isolate
      // shared-home install locks without comparing PIDs from an unrelated SSH host. Its format is
      // load-bearing across versions, which is a second reason never to set ssh2's `hostHash`.
      config.hostVerifier = createHostKeyVerifier({
        host: hostKeyLookupHost,
        port: config.port ?? 22,
        // The name we looked up, not the label: the mismatch message prints `ssh-keygen -R <host>`
        // and a label removes nothing from known_hosts.
        displayHost: hostKeyLookupHost,
        hostKeyStoreFile: boundSshHostKeyStoreFile() ?? undefined,
        strictHostKeyChecking: hostKeyResolved?.strictHostKeyChecking ?? 'ask',
        isHostKeyAlias,
        isEphemeralRuntimeTarget: this.target.owner?.type === 'on-demand-runtime',
        siteConfigSuppressed,
        // A file that EXISTS and will not open is the absence of evidence, not evidence of a new
        // host — the entry that would have said "this key changed" may be in it. An ABSENT file is
        // not this: that is the normal state for a fresh profile and genuinely means nothing is
        // known. The decision connects anyway, as ssh does, but records nothing.
        knownHostsUnreadable: knownHostsEvidence.unreadableFileCount > 0,
        entries: knownHostsEntries,
        // The store's own matcher, against records preloaded above because ssh2's verifier decides
        // synchronously. Reimplementing the comparison here is exactly how the type downgrade got
        // in, and how the host normalisation drifted from the one used to write the records.
        isTrusted: (query) => matchTrustedHostKeys(trustedHostKeys, query),
        rememberHostKey: (record) => {
          void trustHostKey({
            host: record.host,
            port: record.port,
            keyType: record.keyType,
            key: record.key
          }).catch((err) => {
            // A failed write must not fail the connection: we verified the key, we just could not
            // record it, so the next connect re-derives the same answer from known_hosts.
            console.warn('[ssh] failed to record accepted host key:', err)
          })
        },
        isCurrentAttempt: () => !this.disposed && connectGeneration === this.connectGeneration,
        onDecision: (decision) => {
          // Empty when the blob was not a readable host key: there is nothing to identify, and the
          // relay uses this fingerprint to isolate install locks, so blanking it would be worse
          // than leaving the previous one. A REJECTED key is excluded for the same reason read the
          // other way: we refused to talk to that host, so adopting its fingerprint would scope the
          // relay's locks to a host we never accepted.
          if (
            decision.fingerprint &&
            decision.action !== 'reject' &&
            !this.disposed &&
            connectGeneration === this.connectGeneration
          ) {
            this.hostKeyFingerprint = decision.fingerprint
            acceptedFingerprint = decision.fingerprint
          }
          if (decision.action === 'reject') {
            hostKeyRejection = new HostKeyVerificationError(
              decision.reason ?? 'Host key verification failed.',
              decision.outcome
            )
          }
        }
      })

      if (serverHostKeyOrder) {
        config.algorithms = {
          ...config.algorithms,
          serverHostKey: serverHostKeyOrder as NonNullable<
            NonNullable<ConnectConfig['algorithms']>['serverHostKey']
          >
        }
      }

      const onKeyboardInteractive = (
        name: string,
        instructions: string,
        _instructionsLanguage: string,
        prompts: Prompt[],
        finish: KeyboardInteractiveCallback
      ): void => {
        keyboardInteractiveRounds += 1
        if (keyboardInteractiveRounds > SSH_KEYBOARD_INTERACTIVE_MAX_ROUNDS) {
          finish([])
          return
        }
        rearmStartupTimer(SSH_KEYBOARD_INTERACTIVE_READY_TIMEOUT_MS)
        void this.answerKeyboardInteractive(
          config.host || this.target.label,
          name,
          instructions,
          prompts,
          connectGeneration,
          () => rearmStartupTimer(SSH_KEYBOARD_INTERACTIVE_READY_TIMEOUT_MS)
        ).then(
          (responses) => {
            // Settle cancellation immediately, but still answer ssh2’s pending callback.
            if (
              responses === null &&
              (connectGeneration !== this.connectGeneration || this.keyboardInteractiveCancelled)
            ) {
              finish([])
              if (!settled) {
                // Preserve the auth-failed state for explicit cancellation.
                const cancelledError = Object.assign(
                  new Error(
                    `Keyboard-interactive authentication cancelled for ${this.target.label}`
                  ),
                  { level: 'client-authentication' }
                )
                onStartupError(cancelledError)
              }
              return
            }
            const attemptIsCurrent =
              !settled && !this.disposed && connectGeneration === this.connectGeneration
            finish(attemptIsCurrent ? (responses ?? []) : [])
          },
          () => finish([])
        )
      }

      const cleanupStartupListeners = (): void => {
        client.off('ready', onReady)
        client.off('error', onStartupError)
        client.off('keyboard-interactive', onKeyboardInteractive)
        client.off('close', onStartupClose)
        this.pendingSsh2Clients.delete(client)
        clearStartupTimer()
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
          reject(this.createCancelledConnectAttemptError())
          return
        }
        settled = true
        this.client = client
        // Only this successful handshake can publish recovery destination authority.
        this.executionDestination = acceptedFingerprint
          ? {
              client,
              generation: connectGeneration,
              destination: Object.freeze({
                version: 1,
                transport: 'ssh2',
                ...endpoint,
                hostKeyFingerprint: acceptedFingerprint,
                proxyRouteDigest
              })
            }
          : undefined
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
        // Why replace the error: ssh2 reports a denied host key as a generic handshake failure,
        // which the reconnect ladder cannot distinguish from a transient fault and would retry
        // forever against a decision that will never change.
        reject(hostKeyRejection ?? err)
      }

      const onStartupClose = (): void => {
        if (settled) {
          return
        }
        const error =
          this.disposed || connectGeneration !== this.connectGeneration
            ? this.createCancelledConnectAttemptError()
            : Object.assign(new Error('SSH connection closed during authentication'), {
                code: 'ECONNRESET'
              })
        onStartupError(error)
      }

      client.on('keyboard-interactive', onKeyboardInteractive)
      client.on('ready', onReady)
      client.on('error', onStartupError)
      client.on('close', onStartupClose)
      rearmStartupTimer(config.readyTimeout ?? CONNECT_TIMEOUT_MS)
      client.connect({ ...config, readyTimeout: 0 })
    })
  }

  // Why: guard on identity so a late event from the old client can't null out a successful reconnect.
  private setupDisconnectHandler(client: SshClient): void {
    const onDrop = () => {
      if (this.disposed || this.client !== client) {
        return
      }
      this.workLedger.markTransportUnverifiable()
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
      this.workLedger.markTransportUnverifiable()
      this.client = null
      this.scheduleReconnect()
    })
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.resetConnectionFenced || this.reconnectTimer) {
      return
    }
    if (!this.automaticReconnect) {
      this.setState('disconnected')
      return
    }
    const decision = this.reconnectLadder.next(Date.now())
    if (decision.kind === 'give-up') {
      this.setState('reconnection-failed', 'Max reconnection attempts reached')
      return
    }
    this.state.reconnectAttempt = decision.attemptIndex
    this.setState('reconnecting')
    console.warn(
      `[ssh] Reconnecting to ${this.target.label} in ${decision.delayMs}ms (delay step ${decision.attemptIndex + 1}/${RECONNECT_BACKOFF_MS.length}, failed handshakes ${this.reconnectLadder.failedAttemptStreak}/${RECONNECT_BACKOFF_MS.length})`
    )
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null
      if (this.disposed || this.resetConnectionFenced) {
        return
      }
      await this.runReconnectAttempt()
    }, decision.delayMs)
  }

  private async runReconnectAttempt(): Promise<void> {
    this.activeConnectCalls++
    try {
      await this.runTrackedReconnectAttempt()
    } finally {
      this.activeConnectCalls--
      this.transportClosure.notify()
    }
  }

  private async runTrackedReconnectAttempt(): Promise<void> {
    if (this.resetConnectionFenced) {
      return
    }
    const connectGeneration = ++this.connectGeneration
    try {
      // Why: reset before connecting so the 'connected' broadcast carries reconnectAttempt=0, which ssh.ts uses to trigger relay re-establishment.
      this.state.reconnectAttempt = 0
      await this.attemptConnect(connectGeneration)
      if (!this.isCurrentConnectAttempt(connectGeneration)) {
        return
      }
      // Why: attemptConnect resolves only after a real handshake on either transport; the system-ssh probe's 'connected' must not clear the failure streak.
      this.reconnectLadder.markConnected(Date.now())
    } catch (err) {
      // Why: a superseded attempt has no outcome to publish — the attempt that claimed the generation owns the state, and cancellation is that supersession.
      if (this.disposed || !this.isCurrentConnectAttempt(connectGeneration)) {
        return
      }
      const error = err instanceof Error ? err : new Error(String(err))
      if (isCancelledConnectAttemptError(error)) {
        return
      }
      if (isAuthError(error) || isPassphraseError(error)) {
        this.setState('auth-failed', error.message)
        return
      }
      // Why: the system-SSH transport reports timeouts as prose, so the narrow code table would strand FIDO2 targets in 'error' forever.
      if (!isTransientReconnectError(error)) {
        this.setState('error', error.message)
        return
      }
      this.reconnectLadder.markAttemptFailed()
      this.scheduleReconnect()
    }
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
    this.closePendingSsh2Clients()
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
    this.activeConnectCalls++
    try {
      return await this.connectTrackedViaSystemSsh()
    } finally {
      this.activeConnectCalls--
      this.transportClosure.notify()
    }
  }

  private async connectTrackedViaSystemSsh(): Promise<SystemSshProcess> {
    this.assertConnectionReplacementAllowed()
    if (this.disposed) {
      throw new Error('Connection disposed')
    }
    this.unprovenStartupTransport = true
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
          this.workLedger.markTransportUnverifiable()
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

  /** Owned migration transport only; local closure never proves remote process exit. */
  async disconnectAndDrain(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    // An unconnected non-reconnecting owner has nothing live left to fence.
    const settledExclusiveStartup =
      !this.automaticReconnect &&
      this.activeConnectCalls === 0 &&
      this.pendingSsh2Clients.size === 0 &&
      !this.unprovenStartupTransport
    if (
      this.useSystemSshTransport ||
      this.unprovenStartupTransport ||
      this.activeConnectCalls > 0 ||
      (!this.client && !settledExclusiveStartup)
    ) {
      await this.disconnect()
      throw new Error('ssh_connection_close_transport_unproven')
    }
    let fence: ReturnType<SshConnectionWorkLedger['fenceForReset']>
    try {
      if (
        this.client &&
        (this.disposed || this.state.status !== 'connected' || this.pendingSsh2Clients.size > 0)
      ) {
        throw new Error('ssh_connection_reset_transport_not_connected')
      }
      fence = this.workLedger.fenceForReset()
      this.resetConnectionFenced = true
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer)
        this.reconnectTimer = null
      }
    } catch (error) {
      try {
        await this.disconnect()
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'ssh_connection_close_cleanup_failed')
      }
      throw error
    }
    await disconnectAndAwaitSshTransportClose({
      liveResources: [
        ...(this.client ? [this.client] : []),
        ...(this.proxyProcess ? [this.proxyProcess] : [])
      ],
      disconnect: () => this.disconnect(),
      transportCloseLedger: this.transportCloseLedger,
      fence,
      signal
    })
  }

  async disconnect(): Promise<void> {
    this.executionDestination = undefined
    this.disposed = true
    this.connectGeneration += 1
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
    }
    this.reconnectTimer = null
    this.cachedPassphrase = null
    this.cachedPassword = null
    this.credentialAbortController.abort()
    this.closePendingSsh2Clients()
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
    this.reconnectLadder.reset()
    this.setState('disconnected')
    this.transportClosure.notify()
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

export { shouldUseSystemSshTransport } from './ssh-transport-selection'

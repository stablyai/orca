/**
 * PTY provider for plain SSH mode (design D6 rung D): each terminal is one ssh2 session channel
 * with pty-req + shell. Nothing persists on the host, so a lost channel is `unverifiable` and a
 * reconnect starts a fresh shell.
 */
import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import type { ClientChannel, PseudoTtyOptions } from 'ssh2'
import { WRITE_ACCEPTED, type WriteSettlement } from '../../shared/pty-write-settlement'
import { PlainSshUnsupportedError } from '../ssh/ssh-plain-ssh-mode'
import type { SshPlainSshMode } from '../../shared/ssh-types'
import { toAppSshPtyId } from './ssh-pty-id'
import type {
  SshPtyDataCallback,
  SshPtyExitCallback,
  SshPtyReplayCallback
} from './ssh-pty-provider-contract'
import type { IPtyProvider, PtyProcessInfo, PtySpawnOptions, PtySpawnResult } from './types'

export type PlainShellOpener = (pty: PseudoTtyOptions) => Promise<ClientChannel>

type PlainShell = {
  channel: ClientChannel
  incarnation: string
  cwd: string
  cols: number
  rows: number
  exitCode: number | null
  closeRequested: boolean
}

const TERM = 'xterm-256color'
// Why: sshd reports a signalled shell as exit-signal, not exit-status; mirror the shell's 128+n.
const SIGNALLED_EXIT_CODE = 129

function quotePosixPath(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`
}

// Why: a quoted `~` is literal, so the home prefix stays outside the quotes to expand.
function posixCdTarget(path: string): string {
  if (path === '~') {
    return '~'
  }
  return path.startsWith('~/') ? `~/${quotePosixPath(path.slice(2))}` : quotePosixPath(path)
}

export function plainSshTerminalNotice(mode: SshPlainSshMode): string {
  return `\x1b[2m[Orca] Plain SSH terminal: ${mode.message}\x1b[0m\r\n`
}

const LOST_NOTICE =
  '\r\n\x1b[2m[Orca] The SSH connection closed before the shell reported an exit; its state on ' +
  'the host is unverifiable. Plain SSH terminals are not restored on reconnect.\x1b[0m\r\n'

export class SshPlainShellPtyProvider implements IPtyProvider {
  private readonly shells = new Map<string, PlainShell>()
  private readonly lost = new Set<string>()
  private readonly dataListeners = new Set<SshPtyDataCallback>()
  private readonly exitListeners = new Set<SshPtyExitCallback>()
  private disposed = false

  constructor(
    private readonly connectionId: string,
    private readonly openShell: PlainShellOpener,
    private readonly mode: SshPlainSshMode,
    private readonly posixHost: boolean,
    readonly providerGeneration: number
  ) {}

  async spawn(opts: PtySpawnOptions): Promise<PtySpawnResult> {
    if (this.disposed) {
      throw new Error('SSH connection is not active')
    }
    if (opts.agentSessionEnsure || opts.agentSessionCreateOperationId || opts.launchAgent) {
      throw new PlainSshUnsupportedError('Launching agents', this.mode)
    }
    if (opts.attachOnly) {
      throw new PlainSshUnsupportedError('Reattaching a terminal session', this.mode)
    }
    if (opts.signal?.aborted) {
      throw new Error('client_disconnected')
    }
    const cols = Math.max(1, opts.cols)
    const rows = Math.max(1, opts.rows)
    const channel = await this.openShell({ cols, rows, term: TERM })
    if (this.disposed) {
      channel.close()
      throw new Error('SSH connection is not active')
    }
    const id = toAppSshPtyId(this.connectionId, `plain-${randomUUID()}`)
    const shell: PlainShell = {
      channel,
      incarnation: randomUUID(),
      cwd: opts.cwd ?? '',
      cols,
      rows,
      exitCode: null,
      closeRequested: false
    }
    this.shells.set(id, shell)
    this.wireChannel(id, shell)
    this.emitData(id, shell, plainSshTerminalNotice(this.mode))
    if (opts.cwd && this.posixHost) {
      // Why: a shell channel has no cwd request; a leading space keeps it out of most histories.
      channel.write(` cd -- ${posixCdTarget(opts.cwd)}\n`)
    }
    if (opts.command && opts.commandDelivery === 'provider') {
      channel.write(`${opts.command}\n`)
    }
    return {
      id,
      incarnationId: shell.incarnation,
      ...(opts.sessionId ? { sessionExpired: true } : {})
    }
  }

  private wireChannel(id: string, shell: PlainShell): void {
    const stdout = new StringDecoder('utf8')
    const stderr = new StringDecoder('utf8')
    shell.channel.on('data', (chunk: Buffer) => this.emitData(id, shell, stdout.write(chunk)))
    shell.channel.stderr?.on('data', (chunk: Buffer) =>
      this.emitData(id, shell, stderr.write(chunk))
    )
    shell.channel.on('exit', (code: number | null) => {
      shell.exitCode = typeof code === 'number' ? code : SIGNALLED_EXIT_CODE
    })
    // Why: channel errors surface as close; the close handler owns the verdict.
    shell.channel.on('error', () => {})
    shell.channel.on('close', () => this.settleClose(id, shell))
  }

  private settleClose(id: string, shell: PlainShell): void {
    if (this.shells.get(id) !== shell) {
      return
    }
    this.shells.delete(id)
    if (shell.exitCode === null && !shell.closeRequested) {
      // Why: no exit-status means nothing proved the shell ended; report it lost, never exited.
      this.lost.add(id)
      this.emitData(id, shell, LOST_NOTICE)
      return
    }
    const payload = {
      id,
      code: shell.exitCode ?? 0,
      providerGeneration: this.providerGeneration,
      ptyIncarnation: shell.incarnation,
      incarnationId: shell.incarnation
    }
    for (const listener of this.exitListeners) {
      listener(payload)
    }
  }

  private emitData(id: string, shell: PlainShell, data: string): void {
    if (!data) {
      return
    }
    const payload = {
      id,
      data,
      providerGeneration: this.providerGeneration,
      ptyIncarnation: shell.incarnation
    }
    for (const listener of this.dataListeners) {
      listener(payload)
    }
  }

  async attach(id: string): Promise<void> {
    if (!this.shells.has(id)) {
      throw new Error(`PTY ${id} not found`)
    }
  }

  hasPty = (id: string): boolean => this.shells.has(id)

  probePtyLiveness = async (id: string): Promise<boolean | null> => {
    if (this.shells.has(id)) {
      return true
    }
    return this.lost.has(id) ? null : false
  }

  write(id: string, data: string): boolean {
    const shell = this.shells.get(id)
    if (!shell) {
      return false
    }
    shell.channel.write(data)
    return true
  }

  writeWithSettlement(id: string, data: string): WriteSettlement {
    const shell = this.shells.get(id)
    if (!shell) {
      return { outcome: 'refused', reason: 'provider_unavailable' }
    }
    try {
      shell.channel.write(data)
      return WRITE_ACCEPTED
    } catch {
      return {
        outcome: 'unverifiable',
        reason: 'endpoint_write_threw',
        bytesHandedToTransport: false
      }
    }
  }

  resize(id: string, cols: number, rows: number): void {
    const shell = this.shells.get(id)
    if (!shell || cols < 1 || rows < 1) {
      return
    }
    shell.channel.setWindow(rows, cols, 0, 0)
    shell.cols = cols
    shell.rows = rows
  }

  getAppliedSize = async (id: string): Promise<{ cols: number; rows: number } | null> => {
    const shell = this.shells.get(id)
    return shell ? { cols: shell.cols, rows: shell.rows } : null
  }

  async shutdown(id: string): Promise<void> {
    const shell = this.shells.get(id)
    if (!shell) {
      return
    }
    shell.closeRequested = true
    shell.channel.close()
  }

  async sendSignal(id: string, signal: string): Promise<void> {
    this.shells.get(id)?.channel.signal(signal.replace(/^SIG/, ''))
  }

  async getCwd(id: string): Promise<string> {
    return this.shells.get(id)?.cwd ?? ''
  }

  async getInitialCwd(id: string): Promise<string> {
    return this.shells.get(id)?.cwd ?? ''
  }

  async clearBuffer(): Promise<void> {}
  async resetInputModes(): Promise<void> {}
  acknowledgeDataEvent(): void {}

  async hasChildProcesses(): Promise<boolean> {
    return false
  }

  async getForegroundProcess(): Promise<string | null> {
    return null
  }

  async serialize(): Promise<string> {
    return '[]'
  }

  async revive(): Promise<void> {}

  async listProcesses(): Promise<PtyProcessInfo[]> {
    return [...this.shells].map(([id, shell]) => ({
      id,
      incarnationId: shell.incarnation,
      cwd: shell.cwd,
      title: 'ssh'
    }))
  }

  async getDefaultShell(): Promise<string> {
    return ''
  }

  async getProfiles(): Promise<{ name: string; path: string }[]> {
    return []
  }

  supportsAgentSessionClaims = (): boolean => false
  supportsAgentSessionCreateOperations = (): boolean => false
  canProvideAuthoritativeBufferSnapshot = (): boolean => false

  onData(callback: SshPtyDataCallback): () => void {
    this.dataListeners.add(callback)
    return () => this.dataListeners.delete(callback)
  }

  onReplay(_callback: SshPtyReplayCallback): () => void {
    return () => {}
  }

  onExit(callback: SshPtyExitCallback): () => void {
    this.exitListeners.add(callback)
    return () => this.exitListeners.delete(callback)
  }

  /** Transport teardown: every open shell becomes unverifiable; no exit is reported. */
  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    const open = [...this.shells]
    this.shells.clear()
    for (const [id, shell] of open) {
      this.lost.add(id)
      try {
        shell.channel.close()
      } catch {
        // The transport is already gone; nothing left to release.
      }
    }
    this.dataListeners.clear()
    this.exitListeners.clear()
  }
}

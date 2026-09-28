import {
  parseAppWslPtyId,
  toAppWslPtyId,
  toRelayWslPtyId,
  type WslPtyOwner
} from '../../shared/wsl-pty-id'
import type { DaemonPtyAdapter } from '../daemon/daemon-pty-adapter'
import type { IPtyProvider, PtySpawnOptions, PtySpawnResult } from '../providers/types'

/** Only translates identities; the shared daemon adapter owns sessions, snapshots and recovery. */
export class WslDaemonPtyProvider implements IPtyProvider {
  readonly owner: Readonly<WslPtyOwner>

  constructor(
    owner: WslPtyOwner,
    private readonly adapter: DaemonPtyAdapter
  ) {
    this.owner = Object.freeze({ ...owner })
  }

  private guestId = (id: string): string => toRelayWslPtyId(this.owner, id)
  private appId = (id: string): string => toAppWslPtyId(this.owner, id)

  async spawn(options: PtySpawnOptions): Promise<PtySpawnResult> {
    const encoded = options.sessionId && parseAppWslPtyId(options.sessionId)
    if (options.sessionId && !encoded && (options.attachOnly || !options.isNewSession)) {
      throw new Error('Guest daemon attach requires an encoded WSL terminal identity')
    }
    const result = await this.adapter.spawn({
      ...options,
      sessionId: encoded ? this.guestId(options.sessionId!) : options.sessionId,
      terminalWindowsWslDistro: undefined,
      terminalWindowsPowerShellImplementation: undefined
    })
    return {
      ...result,
      id: this.appId(result.id),
      wslDistro: this.owner.distro,
      ...(result.agentSessionEnsure
        ? {
            agentSessionEnsure: {
              ...result.agentSessionEnsure,
              owner: {
                ...result.agentSessionEnsure.owner,
                ptyId: this.appId(result.agentSessionEnsure.owner.ptyId)
              }
            }
          }
        : {})
    }
  }

  attach = (id: string) => this.adapter.attach(this.guestId(id))
  hasPty = (id: string) => this.adapter.hasPty(this.guestId(id))
  probePtyLiveness = (id: string) => this.adapter.probePtyLiveness(this.guestId(id))
  write = (id: string, data: string) => this.adapter.write(this.guestId(id), data)
  writeWithSettlement = (id: string, data: string) =>
    this.adapter.writeWithSettlement(this.guestId(id), data)
  resize = (id: string, cols: number, rows: number) =>
    this.adapter.resize(this.guestId(id), cols, rows)
  pauseProducer = (id: string) => this.adapter.pauseProducer(this.guestId(id))
  resumeProducer = (id: string) => this.adapter.resumeProducer(this.guestId(id))
  setPtyBackgrounded = (id: string, background: boolean) =>
    this.adapter.setPtyBackgrounded(this.guestId(id), background)
  shutdown: IPtyProvider['shutdown'] = (id, options) =>
    this.adapter.shutdown(this.guestId(id), options)
  sendSignal = (id: string, signal: string) => this.adapter.sendSignal(this.guestId(id), signal)
  getCwd = (id: string) => this.adapter.getCwd(this.guestId(id))
  getInitialCwd = (id: string) => this.adapter.getInitialCwd(this.guestId(id))
  clearBuffer = (id: string) => this.adapter.clearBuffer(this.guestId(id))
  closeStartupQueryAuthority = (id: string) =>
    this.adapter.closeStartupQueryAuthority(this.guestId(id))
  acknowledgeDataEvent = (id: string, count: number) =>
    this.adapter.acknowledgeDataEvent(this.guestId(id), count)
  async hasChildProcesses(id: string): Promise<boolean> {
    const guestId = this.guestId(id)
    try {
      const inspection = await this.adapter.inspectProcess(guestId)
      return inspection.childProcessEvidence !== 'no-children'
    } catch {
      return true
    }
  }
  getForegroundProcess = (id: string) => this.adapter.getForegroundProcess(this.guestId(id))
  confirmForegroundProcess = (id: string) => this.adapter.confirmForegroundProcess(this.guestId(id))
  confirmShellForeground = (id: string) => this.adapter.confirmShellForeground(this.guestId(id))
  inspectProcess = (id: string, options?: Parameters<DaemonPtyAdapter['inspectProcess']>[1]) =>
    this.adapter.inspectProcess(this.guestId(id), options)
  getBufferSnapshot = (
    id: string,
    options?: Parameters<DaemonPtyAdapter['getBufferSnapshot']>[1]
  ) => this.adapter.getBufferSnapshot(this.guestId(id), options)
  canProvideAuthoritativeBufferSnapshot = (id: string) =>
    this.adapter.canProvideAuthoritativeBufferSnapshot(this.guestId(id))
  getAppliedSize = (id: string) => this.adapter.getAppliedSize(this.guestId(id))
  supportsGitCredentialGuardHost = () => this.adapter.supportsGitCredentialGuardHost()
  supportsAgentSessionClaims = () => this.adapter.supportsAgentSessionClaims()
  supportsAgentSessionCreateOperations = () => this.adapter.supportsAgentSessionCreateOperations()
  providesAgentSessionOwnerListings = (id: string) =>
    this.adapter.providesAgentSessionOwnerListings(this.guestId(id))
  getDefaultShell = () => this.adapter.getDefaultShell()
  getProfiles = () => this.adapter.getProfiles()
  serialize = (ids: string[]) => this.adapter.serialize(ids.map(this.guestId))
  revive = (state: string) => this.adapter.revive(state)
  ackColdRestore = (id: string) => this.adapter.ackColdRestore(this.guestId(id))

  async listProcesses(options?: Parameters<IPtyProvider['listProcesses']>[0]) {
    const processes = await this.adapter.listProcesses(options)
    return processes.map((entry) => ({
      ...entry,
      id: this.appId(entry.id),
      wslDistro: this.owner.distro,
      ...(entry.agentSessionOwners
        ? {
            agentSessionOwners: entry.agentSessionOwners.map((owner) => ({
              ...owner,
              ptyId: this.appId(owner.ptyId)
            }))
          }
        : {})
    }))
  }

  onData: IPtyProvider['onData'] = (listener) =>
    this.adapter.onData((event) => listener({ ...event, id: this.appId(event.id) }))
  onReplay: IPtyProvider['onReplay'] = (listener) =>
    this.adapter.onReplay((event) => listener({ ...event, id: this.appId(event.id) }))
  onExit: IPtyProvider['onExit'] = (listener) =>
    this.adapter.onExit((event) => listener({ ...event, id: this.appId(event.id) }))
  onBackgroundStreamEvent: NonNullable<IPtyProvider['onBackgroundStreamEvent']> = (listener) =>
    this.adapter.onBackgroundStreamEvent((event) =>
      listener({ ...event, id: this.appId(event.id) })
    )
  onWriteUnavailable: NonNullable<IPtyProvider['onWriteUnavailable']> = (listener) =>
    this.adapter.onWriteUnavailable((event) => listener({ ...event, id: this.appId(event.id) }))
  establishLifecycleLease = () => this.adapter.establishLifecycleLease()
  disconnectOnly = () => this.adapter.disconnectOnly()
}

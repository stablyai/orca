import { randomBytes, randomUUID } from 'crypto'
import type { RuntimeTerminalSummary } from '../../shared/runtime-types'
import type {
  RemoteControlCapability,
  RemoteControlPairingState,
  RemoteControlSession,
  RemoteControlSnapshot,
  RemoteControlTransportMode
} from '../../shared/remote-control-types'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'

const DEFAULT_PAIRING_TTL_MS = 10 * 60 * 1000

export function buildRemoteControlSessions(
  terminals: RuntimeTerminalSummary[]
): RemoteControlSession[] {
  return terminals
    .map((terminal) => ({
      sessionId: `${terminal.tabId}:${terminal.leafId}`,
      worktreeId: terminal.worktreeId,
      worktreePath: terminal.worktreePath,
      branch: terminal.branch,
      tabId: terminal.tabId,
      leafId: terminal.leafId,
      title: terminal.title,
      connected: terminal.connected,
      writable: terminal.writable,
      lastOutputAt: terminal.lastOutputAt,
      preview: terminal.preview,
      capabilities: buildCapabilities(terminal)
    }))
    .sort(compareRemoteControlSessions)
}

export class RemoteControlService {
  private readonly runtime: OrcaRuntimeService
  private enabled = false
  private transportMode: RemoteControlTransportMode = 'local_only'
  private pairing: RemoteControlPairingState | null = null

  constructor(runtime: OrcaRuntimeService) {
    this.runtime = runtime
  }

  async getSnapshot(): Promise<RemoteControlSnapshot> {
    return {
      enabled: this.enabled,
      publishedAt: Date.now(),
      transportMode: this.transportMode,
      pairing: this.pairing,
      sessions: this.enabled ? await this.listSessions() : []
    }
  }

  async enable(options?: {
    deviceLabel?: string
    transportMode?: RemoteControlTransportMode
    ttlMs?: number
  }): Promise<RemoteControlSnapshot> {
    this.enabled = true
    this.transportMode = options?.transportMode ?? 'local_only'
    this.pairing = createPairingState({
      deviceLabel: options?.deviceLabel ?? 'Owner iPhone',
      transportMode: this.transportMode,
      ttlMs: options?.ttlMs ?? DEFAULT_PAIRING_TTL_MS
    })
    return this.getSnapshot()
  }

  async refreshPairing(options?: {
    deviceLabel?: string
    ttlMs?: number
  }): Promise<RemoteControlSnapshot> {
    if (!this.enabled) {
      return this.getSnapshot()
    }
    this.pairing = createPairingState({
      deviceLabel: options?.deviceLabel ?? this.pairing?.deviceLabel ?? 'Owner iPhone',
      transportMode: this.transportMode,
      ttlMs: options?.ttlMs ?? DEFAULT_PAIRING_TTL_MS
    })
    return this.getSnapshot()
  }

  async disable(): Promise<RemoteControlSnapshot> {
    this.enabled = false
    this.pairing = null
    return this.getSnapshot()
  }

  private async listSessions(): Promise<RemoteControlSession[]> {
    const { terminals } = await this.runtime.listTerminals()
    // Why: the phone must resume the exact PTY leaf the laptop is already
    // showing, not a coarser worktree bucket that would lose pane-level
    // context and make "continue this session" ambiguous.
    return buildRemoteControlSessions(terminals)
  }
}

function buildCapabilities(terminal: RuntimeTerminalSummary): RemoteControlCapability[] {
  const capabilities: RemoteControlCapability[] = ['view_output', 'switch_session']
  if (terminal.writable) {
    capabilities.push('send_input', 'send_interrupt', 'approve_action', 'run_command')
  }
  return capabilities
}

function compareRemoteControlSessions(a: RemoteControlSession, b: RemoteControlSession): number {
  const activityDelta = (b.lastOutputAt ?? 0) - (a.lastOutputAt ?? 0)
  if (activityDelta !== 0) {
    return activityDelta
  }
  return (a.title ?? a.branch).localeCompare(b.title ?? b.branch)
}

function createPairingState(options: {
  deviceLabel: string
  transportMode: RemoteControlTransportMode
  ttlMs: number
}): RemoteControlPairingState {
  const issuedAt = Date.now()
  const expiresAt = issuedAt + Math.max(30_000, options.ttlMs)
  const pairingId = randomUUID()
  const accessToken = randomBytes(24).toString('base64url')
  return {
    pairingId,
    issuedAt,
    expiresAt,
    deviceLabel: options.deviceLabel,
    transportMode: options.transportMode,
    accessToken,
    qrPayload: JSON.stringify({
      version: 1,
      pairingId,
      accessToken,
      transportMode: options.transportMode,
      expiresAt
    })
  }
}

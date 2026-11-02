/**
 * The bridge's own IPC channels, and the live collaborators it runs with.
 * COMPAT(legacy-relay-bridge): revisit 2027-01-15.
 */
import { ipcMain, type BrowserWindow } from 'electron'
import { z } from 'zod'
import { LEGACY_RELAY_BRIDGE_CHANNELS as CHANNELS } from '../../../shared/legacy-relay-bridge-contract'
import { isRemoteCliControlAllowed } from '../../../shared/ssh-remote-cli-control'
import type { Store } from '../../persistence'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { track } from '../../telemetry/client'
import type { SshConnection } from '../ssh-connection'
import { knownSshHostPlatform } from '../ssh-host-platform-memo'
import { hostProps } from '../ssh-host-server-telemetry'
import {
  attachLegacyRelayPane,
  closeLegacyRelayPane,
  detachLegacyRelayPane,
  installLegacyRelayBridge,
  legacyRelayBridgedPanes,
  resizeLegacyRelayPane,
  setLegacyRelayPaneOutputPaused,
  terminalsBucket,
  writeLegacyRelayPane
} from './legacy-relay-bridge-registry'

const PtyIdSchema = z.string().min(1).max(4096)
const SizeSchema = z.number().int().positive().max(10_000)
const PaneArgsSchema = z.object({ ptyId: PtyIdSchema })
const DetachArgsSchema = z.object({ ptyId: PtyIdSchema, acquisitionId: z.number().int() })
const AttachArgsSchema = z.object({ ptyId: PtyIdSchema, replayInStream: z.boolean().optional() })
const WriteArgsSchema = z.object({ ptyId: PtyIdSchema, data: z.string() })
const PausedArgsSchema = z.object({ ptyId: PtyIdSchema, paused: z.boolean() })
const ResizeArgsSchema = z.object({ ptyId: PtyIdSchema, cols: SizeSchema, rows: SizeSchema })

export function registerLegacyRelayBridgeIpc(args: {
  store: Pick<Store, 'getSshRemotePtyLeases' | 'markSshRemotePtyLease' | 'getSshTarget'>
  getMainWindow: () => BrowserWindow | null
  connection: (targetId: string) => SshConnection | null
  runtime?: () => OrcaRuntimeService | null
}): void {
  const send = (channel: string, payload: unknown): void => {
    const contents = args.getMainWindow()?.webContents
    if (contents && !contents.isDestroyed()) {
      contents.send(channel, payload)
    }
  }
  installLegacyRelayBridge({
    leases: (targetId) => args.store.getSshRemotePtyLeases(targetId),
    retireLease: (targetId, relayPtyId) =>
      args.store.markSshRemotePtyLease(targetId, relayPtyId, 'terminated'),
    connection: args.connection,
    ...(args.runtime
      ? {
          remoteCli: {
            runtime: args.runtime,
            allowed: (targetId: string) =>
              isRemoteCliControlAllowed(args.store.getSshTarget(targetId))
          }
        }
      : {}),
    onPanesChanged: (panes) => send(CHANNELS.panes, panes),
    onData: (ptyId, data) => send(CHANNELS.data, { ptyId, data }),
    onReplay: (ptyId, replay) => send(CHANNELS.replay, { ptyId, replay }),
    onExit: (ptyId, code) => send(CHANNELS.exit, { ptyId, code }),
    report: (targetId, phase, terminals) => {
      try {
        track('ssh_host_server_legacy_relay_bridge', {
          phase,
          terminals: terminalsBucket(terminals),
          ...hostProps(knownSshHostPlatform(targetId))
        })
      } catch {
        // Telemetry never costs a terminal.
      }
    }
  })
  ipcMain.removeHandler(CHANNELS.listPanes)
  ipcMain.removeHandler(CHANNELS.attach)
  ipcMain.removeHandler(CHANNELS.close)
  for (const channel of [
    CHANNELS.write,
    CHANNELS.resize,
    CHANNELS.setOutputPaused,
    CHANNELS.detach
  ]) {
    ipcMain.removeAllListeners(channel)
  }
  ipcMain.handle(CHANNELS.listPanes, () => legacyRelayBridgedPanes())
  ipcMain.handle(CHANNELS.attach, async (_event, payload: unknown) => {
    const args = AttachArgsSchema.safeParse(payload)
    return args.success
      ? attachLegacyRelayPane(args.data.ptyId, args.data.replayInStream === true)
      : { status: 'not-bridged' }
  })
  ipcMain.handle(CHANNELS.close, async (_event, payload: unknown) => {
    const args = PaneArgsSchema.safeParse(payload)
    return args.success ? closeLegacyRelayPane(args.data.ptyId) : { status: 'not-bridged' }
  })
  ipcMain.on(CHANNELS.write, (_event, payload: unknown) => {
    const args = WriteArgsSchema.safeParse(payload)
    if (args.success) {
      writeLegacyRelayPane(args.data.ptyId, args.data.data)
    }
  })
  ipcMain.on(CHANNELS.resize, (_event, payload: unknown) => {
    const args = ResizeArgsSchema.safeParse(payload)
    if (args.success) {
      resizeLegacyRelayPane(args.data.ptyId, args.data.cols, args.data.rows)
    }
  })
  ipcMain.on(CHANNELS.setOutputPaused, (_event, payload: unknown) => {
    const args = PausedArgsSchema.safeParse(payload)
    if (args.success) {
      setLegacyRelayPaneOutputPaused(args.data.ptyId, args.data.paused)
    }
  })
  ipcMain.on(CHANNELS.detach, (_event, payload: unknown) => {
    const args = DetachArgsSchema.safeParse(payload)
    if (args.success) {
      detachLegacyRelayPane(args.data.ptyId, args.data.acquisitionId)
    }
  })
}

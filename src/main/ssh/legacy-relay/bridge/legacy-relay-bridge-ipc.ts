/**
 * The bridge's own IPC channels; the desktop adapter for the legacy relay bridge.
 * COMPAT(legacy-relay-bridge): revisit 2027-01-15.
 */
import { ipcMain } from 'electron'
import { z } from 'zod'
import { LEGACY_RELAY_BRIDGE_CHANNELS as CHANNELS } from '../../../../shared/remote-runtime/relay/legacy-relay-bridge-contract'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import {
  attachLegacyRelayPane,
  closeLegacyRelayPane,
  detachLegacyRelayPane,
  legacyRelayBridgedPanes,
  resizeLegacyRelayPane,
  setLegacyRelayOutputPaused,
  writeLegacyRelayPane
} from './legacy-relay-bridge-registry'

const PtyIdSchema = z.string().min(1).max(4096)
const SizeSchema = z.number().int().positive().max(10_000)
const PaneArgsSchema = z.object({ ptyId: PtyIdSchema })
const DetachArgsSchema = z.object({ ptyId: PtyIdSchema, acquisitionId: z.number().int() })
const AttachArgsSchema = z.object({ ptyId: PtyIdSchema, replayInStream: z.boolean().optional() })
const WriteArgsSchema = z.object({ ptyId: PtyIdSchema, data: z.string() })
const PausedArgsSchema = z.object({
  ptyId: PtyIdSchema,
  paused: z.boolean(),
  replayNeeded: z.boolean().optional()
})
const ResizeArgsSchema = z.object({ ptyId: PtyIdSchema, cols: SizeSchema, rows: SizeSchema })

export function registerLegacyRelayBridgeIpc(args: {
  runtime?: () => OrcaRuntimeService | null
}): void {
  const runtime = args.runtime
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
    if (!args.success) {
      return { status: 'not-bridged' }
    }
    // A deliberate close, as the kill routes record, so its exit reads as an operator close.
    runtime?.()?.markPtyStopRequested(args.data.ptyId)
    return closeLegacyRelayPane(args.data.ptyId)
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
      setLegacyRelayOutputPaused(args.data.ptyId, args.data.paused, args.data.replayNeeded)
    }
  })
  ipcMain.on(CHANNELS.detach, (_event, payload: unknown) => {
    const args = DetachArgsSchema.safeParse(payload)
    if (args.success) {
      detachLegacyRelayPane(args.data.ptyId, args.data.acquisitionId)
    }
  })
}

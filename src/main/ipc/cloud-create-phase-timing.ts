// N-01: per-create phase timing in the main app log, so a slow "Start sandbox" can be localised from
// app.log alone: `[orca-cloud] create <creationId> <phase> +<ms>`. Ids and phase names only, never
// tokens, URLs or pairing codes.
import { ipcMain } from 'electron'
import {
  cloudCreatePhaseFromProvisionLine,
  isCloudCreateRendererPhase,
  type CloudCreatePhase
} from '../../shared/orca-cloud/cloud-create-phases'

const startedAt = new Map<string, number>()
// A create that never reports its end must not keep its entry forever.
const MAX_TRACKED_CREATES = 64

export function noteCloudCreatePhase(
  creationId: string | undefined,
  phase: CloudCreatePhase,
  options: { now?: number; log?: (line: string) => void } = {}
): void {
  if (!creationId || !/^[A-Za-z0-9_-]{1,80}$/.test(creationId)) {
    return
  }
  const now = options.now ?? Date.now()
  if (phase === 'provision-start' || !startedAt.has(creationId)) {
    startedAt.set(creationId, now)
    if (startedAt.size > MAX_TRACKED_CREATES) {
      startedAt.delete(startedAt.keys().next().value as string)
    }
  }
  const since = now - (startedAt.get(creationId) ?? now)
  ;(options.log ?? console.info)(`[orca-cloud] create ${creationId} ${phase} +${since}`)
  if (phase === 'workspace-open' || phase === 'failed') {
    startedAt.delete(creationId)
  }
}

/** Notes every driver progress line in a provision event chunk. */
export function noteCloudCreateProvisionChunk(creationId: string | undefined, chunk: string): void {
  for (const line of chunk.split('\n')) {
    const phase = cloudCreatePhaseFromProvisionLine(line)
    if (phase) {
      noteCloudCreatePhase(creationId, phase)
    }
  }
}

/** The renderer's phases after the provision returns; anything else is ignored. */
export function registerCloudCreatePhaseNotes(): void {
  // Why: a handle (not on) so re-registering replaces the listener instead of doubling every line.
  ipcMain.removeHandler('ephemeralVm:notePhase')
  ipcMain.handle(
    'ephemeralVm:notePhase',
    (_event, args: { provisionId?: unknown; phase?: unknown }): void => {
      if (typeof args?.provisionId === 'string' && isCloudCreateRendererPhase(args.phase)) {
        noteCloudCreatePhase(args.provisionId, args.phase)
      }
    }
  )
}

export function resetCloudCreatePhaseTimingForTest(): void {
  startedAt.clear()
}

/**
 * Undo's automation step. A released move's automations run here again, so every one of the
 * move's host copies that is on turns off first, and the copy here takes the host's state, the
 * user's latest choice: each runs in exactly one place. That state is recorded on the move before
 * anything turns off, so a crash or a refusal that left one off never passes for the choice. A
 * refused undo turns back on what it turned off and changes nothing here; one it cannot turn back
 * on is recorded, shown and retried.
 */
import type { Automation } from '../../../../shared/automations/automation-definition'
import type { WslMoveCutover } from '../../../../shared/wsl-move/wsl-move-cutover'
import { listWslMoveCutovers, writeWslMoveCutover } from './wsl-move-cutover-journal'
import { runWslMoveHostAutomationsTurn } from './wsl-move-host-automations-lock'
import { wslMoveAutomationsPending } from '../desktop-state/wsl-move-host-automations-rewrite'

export type WslMoveHostAutomationStop =
  | {
      outcome: 'stopped'
      /** A later undo step refused: turn back on what this attempt turned off on the host. */
      restore: () => Promise<void>
      /** Persists the recorded host state here; resolves to how to undo that write. */
      applyHere: () => Promise<() => Promise<void>>
    }
  | { outcome: 'unreachable' | 'failed' | 'removal-pending' }

export type WslMoveLocalAutomationStateUpdate = { id: string; enabled: boolean }

export type WslMoveLocalAutomationWriteResult = {
  applied: WslMoveLocalAutomationStateUpdate[]
  error?: unknown
}

export type WslMoveHostAutomationPorts = {
  /** The host's state of each; one deleted there reads `deleted`, and stays off here. */
  read: (automationIds: readonly string[]) => Promise<Record<string, boolean | 'deleted'>>
  /** Throws on a refusal; ids it could not turn back on ride the error as `leftOff`. */
  disable: (automationIds: readonly string[]) => Promise<string[]>
  restore: (automationIds: readonly string[]) => Promise<void>
  listHere: () => readonly Pick<Automation, 'id' | 'enabled'>[]
  setHere: (
    updates: readonly WslMoveLocalAutomationStateUpdate[]
  ) => WslMoveLocalAutomationWriteResult
  /** Copies turned back on: each schedule's next run moves past now, as a disabled one is never advanced. */
  advanceHere: (automationIds: readonly string[]) => void
  /** Makes the local automation writes durable before the cutover record is dropped. */
  flushHere: () => Promise<void>
}

/** Every automation the move carried, whatever its state here or on the host. */
export function wslMoveMovedAutomationIds(move: {
  manifest: { payload: { dormantState?: { automations?: readonly { id: string }[] } } }
}): string[] {
  return (move.manifest.payload.dormantState?.automations ?? []).map(({ id }) => id)
}

/** The copies here whose `enabled` differs from the user's choice. */
export function wslMoveLocalAutomationStateUpdates(
  localAutomations: readonly Pick<Automation, 'id' | 'enabled'>[],
  intent: Readonly<Record<string, boolean>>
): { id: string; enabled: boolean }[] {
  return localAutomations.flatMap((automation) => {
    const enabled = intent[automation.id]
    return enabled === undefined || enabled === automation.enabled
      ? []
      : [{ id: automation.id, enabled }]
  })
}

function classify(error: unknown): 'failed' | 'unreachable' {
  const message = error instanceof Error ? error.message : String(error)
  return message.startsWith('wsl_move_automation_') ? 'failed' : 'unreachable'
}

function leftOffOf(error: unknown): string[] {
  return typeof error === 'object' &&
    error !== null &&
    'leftOff' in error &&
    Array.isArray(error.leftOff)
    ? error.leftOff.filter((id): id is string => typeof id === 'string')
    : []
}

export async function stopWslMoveHostAutomations(
  userDataPath: string,
  migrationId: string,
  automationIds: readonly string[],
  ports: WslMoveHostAutomationPorts
): Promise<WslMoveHostAutomationStop> {
  if (automationIds.length === 0) {
    return { outcome: 'stopped', restore: async () => {}, applyHere: async () => async () => {} }
  }
  let read: Record<string, boolean | 'deleted'>
  try {
    read = await ports.read(automationIds)
  } catch (error) {
    return { outcome: classify(error) }
  }
  const deleted = new Set(Object.keys(read).filter((id) => read[id] === 'deleted'))
  const hostStates = Object.fromEntries(
    Object.entries(read).map(([id, state]) => [id, state === true])
  )
  const { intent, recorded } = recordUndoIntent(userDataPath, migrationId, hostStates, deleted)
  let turnedOff: string[]
  try {
    turnedOff = await ports.disable(automationIds.filter((id) => hostStates[id]))
  } catch (error) {
    settleRefusedUndo(userDataPath, migrationId, recorded, leftOffOf(error))
    return { outcome: classify(error) }
  }
  return {
    outcome: 'stopped',
    restore: async () => {
      let leftOff: string[] = []
      try {
        await ports.restore(turnedOff)
      } catch (error) {
        console.warn('[wsl-move] Could not turn host automations back on:', error)
        leftOff = leftOffOf(error).length > 0 ? leftOffOf(error) : turnedOff
      }
      settleRefusedUndo(userDataPath, migrationId, recorded, leftOff)
    },
    applyHere: () =>
      applyWslMoveAutomationStatesHere(
        ports,
        wslMoveAutomationIntentHere(readMove(userDataPath, migrationId), intent)
      )
  }
}

/** The move turned these off here (local-automations); they were on before it. */
export function wslMoveAutomationsOnBeforeMove(
  move: Pick<WslMoveCutover, 'automationsToReenable'> | undefined
): Record<string, boolean> {
  return Object.fromEntries((move?.automationsToReenable ?? []).map((id) => [id, true]))
}

/**
 * The state each copy here takes: the host's, except where the host holds no real choice (never
 * confirmed to have turned on, or not present in `hostIntent`).
 */
export function wslMoveAutomationIntentHere(
  move: Parameters<typeof wslMoveAutomationsPending>[0] | undefined,
  hostIntent: Readonly<Record<string, boolean>>
): Record<string, boolean> {
  const before = wslMoveAutomationsOnBeforeMove(move)
  const pending = move ? wslMoveAutomationsPending(move) : []
  return {
    ...before,
    ...hostIntent,
    ...Object.fromEntries(pending.map((id) => [id, true]))
  }
}

/** Gives the copies here `intent` and flushes them to disk; resolves to how to undo that write. */
export async function applyWslMoveAutomationStatesHere(
  ports: Pick<WslMoveHostAutomationPorts, 'listHere' | 'setHere' | 'advanceHere' | 'flushHere'>,
  intent: Readonly<Record<string, boolean>>
): Promise<() => Promise<void>> {
  const updates = wslMoveLocalAutomationStateUpdates(ports.listHere(), intent)
  if (updates.length === 0) {
    return async () => {}
  }
  const { applied, error } = ports.setHere(updates)
  const revert = async () => {
    if (applied.length === 0) {
      return
    }
    try {
      ports.setHere(applied.map(({ id, enabled }) => ({ id, enabled: !enabled })))
      await ports.flushHere()
    } catch (revertError) {
      console.warn('[wsl-move] Could not put an automation here back:', revertError)
    }
  }
  if (error !== undefined) {
    await revert()
    throw error
  }
  try {
    const enabledIds = applied.filter((update) => update.enabled).map((update) => update.id)
    if (enabledIds.length > 0) {
      ports.advanceHere(enabledIds)
    }
    await ports.flushHere()
  } catch (applyError) {
    await revert()
    throw applyError
  }
  return revert
}

function readMove(userDataPath: string, migrationId: string): WslMoveCutover | undefined {
  return listWslMoveCutovers(userDataPath).find((entry) => entry.migrationId === migrationId)
}

/**
 * Adds what this attempt read; an earlier attempt's entry wins, as the host shows its own off.
 * A deletion on the host is the user's latest choice instead: it overrides any earlier entry.
 */
function recordUndoIntent(
  userDataPath: string,
  migrationId: string,
  hostStates: Readonly<Record<string, boolean>>,
  deleted: ReadonlySet<string>
): { intent: Record<string, boolean>; recorded: string[] } {
  const cutover = readMove(userDataPath, migrationId)
  // Left off by an earlier undo: on is the choice, whatever the host shows now, unless deleted.
  const earlier = Object.fromEntries(
    Object.entries({
      ...Object.fromEntries((cutover?.hostAutomationsLeftOff ?? []).map((id) => [id, true])),
      ...cutover?.undoHostAutomationIntent
    }).filter(([id]) => !deleted.has(id))
  )
  const recorded = Object.keys(hostStates).filter((id) => !Object.hasOwn(earlier, id))
  const intent = { ...hostStates, ...earlier }
  const leftOff = cutover?.hostAutomationsLeftOff ?? []
  // A deleted one can no longer be turned back on there, so it stops waiting to be retried.
  const keptLeftOff = leftOff.filter((id) => !deleted.has(id))
  if (cutover && (recorded.length > 0 || keptLeftOff.length !== leftOff.length)) {
    writeWslMoveCutover(userDataPath, withUndoAutomationFields(cutover, intent, keptLeftOff))
  }
  return { intent, recorded }
}

/** A refused undo forgets what it recorded, except what it left off, which waits to be retried. */
function settleRefusedUndo(
  userDataPath: string,
  migrationId: string,
  recorded: readonly string[],
  leftOff: readonly string[]
): void {
  const cutover = readMove(userDataPath, migrationId)
  if (!cutover) {
    return
  }
  const kept = new Set(leftOff)
  const forget = new Set(recorded.filter((id) => !kept.has(id)))
  const intent = Object.fromEntries(
    Object.entries(cutover.undoHostAutomationIntent ?? {}).filter(([id]) => !forget.has(id))
  )
  const left = [...new Set([...(cutover.hostAutomationsLeftOff ?? []), ...leftOff])].sort()
  writeWslMoveCutover(userDataPath, withUndoAutomationFields(cutover, intent, left))
}

function withUndoAutomationFields(
  cutover: WslMoveCutover,
  intent: Record<string, boolean>,
  leftOff: string[]
): WslMoveCutover {
  const { undoHostAutomationIntent: _intent, hostAutomationsLeftOff: _leftOff, ...rest } = cutover
  return {
    ...rest,
    ...(Object.keys(intent).length > 0 ? { undoHostAutomationIntent: intent } : {}),
    ...(leftOff.length > 0 ? { hostAutomationsLeftOff: leftOff } : {})
  }
}

/**
 * At startup no undo is running, so a recorded choice is an undo a crash interrupted: what it
 * read as on goes back on through the retry and keeps its choice for a later undo; the rest clears.
 */
export function settleInterruptedWslMoveUndos(userDataPath: string): void {
  for (const cutover of listWslMoveCutovers(userDataPath)) {
    const intent = cutover.undoHostAutomationIntent
    if (!intent) {
      continue
    }
    const on = Object.entries(intent).flatMap(([id, enabled]) => (enabled ? [id] : []))
    const left = [...new Set([...(cutover.hostAutomationsLeftOff ?? []), ...on])].sort()
    const kept = Object.fromEntries(on.map((id) => [id, true]))
    writeWslMoveCutover(userDataPath, withUndoAutomationFields(cutover, kept, left))
  }
}

export type WslMoveHostAutomationRetryHost = {
  restore: (
    environmentId: string,
    automationIds: readonly string[],
    signal?: AbortSignal
  ) => Promise<void>
  disable: (
    environmentId: string,
    automationIds: readonly string[],
    signal?: AbortSignal
  ) => Promise<unknown>
}

/** Turns back on what refused undos left off; true while any is still left off. */
export async function retryWslMoveHostAutomationsLeftOff(
  userDataPath: string,
  host: WslMoveHostAutomationRetryHost
): Promise<boolean> {
  let remaining = false
  for (const { migrationId } of listWslMoveCutovers(userDataPath)) {
    const left = await runWslMoveHostAutomationsTurn(async (signal) => {
      // Fresh inside the turn: an undo may have released the move, or a pass advanced it.
      const cutover = readMove(userDataPath, migrationId)
      const ids = cutover?.hostAutomationsLeftOff ?? []
      if (!cutover || ids.length === 0) {
        return 0
      }
      let stillOff: string[] = []
      try {
        // Unraced: restore ends each request at the deadline and its error names what stayed off.
        await host.restore(cutover.destinationEnvironmentId, ids, signal)
      } catch (error) {
        stillOff = leftOffOf(error).length > 0 ? leftOffOf(error) : ids
      }
      const turnedOn = new Set(ids.filter((id) => !stillOff.includes(id)))
      const current = readMove(userDataPath, migrationId)
      if (!current) {
        // Released meanwhile: the project is local again, so what this turned on goes back off.
        await host
          .disable(cutover.destinationEnvironmentId, [...turnedOn], signal)
          .catch((error) => {
            console.warn("[wsl-move] Could not turn a released move's host automations off:", error)
          })
        return 0
      }
      const leftOff = (current.hostAutomationsLeftOff ?? []).filter((id) => !turnedOn.has(id))
      const intent = Object.fromEntries(
        Object.entries(current.undoHostAutomationIntent ?? {}).filter(([id]) => !turnedOn.has(id))
      )
      writeWslMoveCutover(userDataPath, withUndoAutomationFields(current, intent, leftOff))
      return leftOff.length
    })
    remaining ||= left > 0
  }
  return remaining
}

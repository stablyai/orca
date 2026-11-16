/**
 * Undo's host step for automations: a released move's automations run here again, so the host's
 * copies turn off first, or each would run twice, once on each side of the same files.
 */
import {
  AUTOMATION_NOT_FOUND,
  ShownAutomationSchema,
  openWslHostAutomationApi,
  type WslHostAutomationApi
} from './wsl-host-automation-enable'

/** A disable that refused partway and could not turn back on `leftOff`, which stay off. */
export class WslHostAutomationsLeftOffError extends Error {
  constructor(
    message: string,
    readonly leftOff: string[]
  ) {
    super(message)
  }
}

/** Each one's state on the host, the user's latest choice; one deleted there reads as off. */
export async function readWslHostAutomationStates(
  userDataPath: string,
  environmentId: string,
  automationIds: readonly string[]
): Promise<Record<string, boolean>> {
  const states: Record<string, boolean> = {}
  if (automationIds.length === 0) {
    return states
  }
  const request = await openWslHostAutomationApi(userDataPath, environmentId)
  for (const id of automationIds) {
    const shown = await request('automation.show', { id })
    if (!shown.ok) {
      if (!shown.error.message.includes(AUTOMATION_NOT_FOUND)) {
        throw new Error(`wsl_move_automation_read_failed:${shown.error.message}`)
      }
      states[id] = false
      continue
    }
    states[id] = ShownAutomationSchema.parse(shown.result).automation.enabled
  }
  return states
}

/**
 * Turns each off and returns them. On a refusal it turns back on the ones it had turned off,
 * then throws; any it could not turn back on ride the error as `leftOff`.
 */
export async function disableWslHostAutomations(
  userDataPath: string,
  environmentId: string,
  automationIds: readonly string[]
): Promise<string[]> {
  if (automationIds.length === 0) {
    return []
  }
  const request = await openWslHostAutomationApi(userDataPath, environmentId)
  const turnedOff: string[] = []
  try {
    for (const id of automationIds) {
      const updated = await request('automation.update', { id, updates: { enabled: false } })
      if (!updated.ok) {
        throw new Error(`wsl_move_automation_disable_failed:${updated.error.message}`)
      }
      turnedOff.push(id)
    }
  } catch (error) {
    // A refused undo leaves the host as it found it (X1), as far as the host lets it.
    const leftOff = await turnOnEach(request, turnedOff)
    const message = error instanceof Error ? error.message : String(error)
    throw leftOff.length > 0 ? new WslHostAutomationsLeftOffError(message, leftOff) : error
  }
  return turnedOff
}

/** Turns back on what disableWslHostAutomations turned off, when undo then refuses. */
export async function restoreWslHostAutomations(
  userDataPath: string,
  environmentId: string,
  automationIds: readonly string[]
): Promise<void> {
  if (automationIds.length === 0) {
    return
  }
  const request = await openWslHostAutomationApi(userDataPath, environmentId)
  const leftOff = await turnOnEach(request, automationIds)
  if (leftOff.length > 0) {
    throw new WslHostAutomationsLeftOffError('wsl_move_automation_enable_failed', leftOff)
  }
}

/**
 * The ids it could not turn on. A refusal skips just that one; a host that stops answering ends
 * the pass, leaving the rest off, rather than hold undo's turn waiting on each.
 */
async function turnOnEach(
  request: WslHostAutomationApi,
  ids: readonly string[]
): Promise<string[]> {
  const leftOff: string[] = []
  for (const [index, id] of ids.entries()) {
    try {
      const updated = await request('automation.update', { id, updates: { enabled: true } })
      if (!updated.ok) {
        leftOff.push(id)
      }
    } catch {
      return [...leftOff, ...ids.slice(index)]
    }
  }
  return leftOff
}

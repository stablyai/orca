import { AcpRequestTimeoutError } from './acp-errors'
import type { PromptResponse } from './generated/acp-protocol.generated'

export type ActivePrompt = {
  response: Promise<PromptResponse>
  cancelling: boolean
  cancelPromise?: Promise<void>
  steerCancel?: Promise<void>
}

/** How a cancel reaches the agent: the `session/cancel` write and the connection it rides on. */
export type AcpCancelChannel = {
  send: () => Promise<void>
  /** Cancels the agent's open requests (permissions, vendor hooks) so each gets its answer. */
  cancelIncomingRequests: () => void
  close: (error: Error) => void
  closed: () => boolean
  timeoutMs: number
}

/** A Stop's cancel. Sends `session/cancel` whenever the session runs: the agent may be in a turn it
 *  began itself. With Orca's prompt running, also waits (bounded) for that prompt to settle, and
 *  past the bound closes the connection, which ends the agent. Repeated asks share one wait. */
export function cancelAcpPromptForStop(
  active: ActivePrompt | undefined,
  channel: AcpCancelChannel
): Promise<void> {
  channel.cancelIncomingRequests()
  if (!active) {
    return channel.send()
  }
  active.cancelling = true
  active.cancelPromise ??= confirmAcpPromptCancel(active, channel)
  return active.cancelPromise
}

/** Sends `session/cancel` and waits, bounded, for Orca's prompt to settle; past the bound it closes. */
async function confirmAcpPromptCancel(
  active: ActivePrompt,
  connection: AcpCancelChannel
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const unconfirmed = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new AcpRequestTimeoutError('session/cancel')
      connection.close(error)
      reject(error)
    }, connection.timeoutMs)
  })
  try {
    await Promise.race([connection.send(), unconfirmed]).catch((error) => {
      // Only a cancel that reached the agent is shared; a failed write is retried next call.
      active.cancelPromise = undefined
      active.cancelling = false
      throw error
    })
    await Promise.race([
      active.response.catch((error) => {
        if (connection.closed()) {
          throw error
        }
      }),
      unconfirmed
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** A steer's cancel: asks the agent once to end Orca's running prompt so the steer can follow it,
 *  and resolves when the notification is written. Never bounded and never closes: the prompt's own
 *  reply ends it, however long that takes, and a later Stop still bounds. A prompt that fails
 *  instead leaves a session the steer must not be sent into until the caller rebuilds it. With no
 *  prompt of Orca's there is nothing to end; a Stop already cancelling it owns that cancel. */
export function requestAcpSteerCancel(
  active: ActivePrompt | undefined,
  channel: Pick<AcpCancelChannel, 'send' | 'cancelIncomingRequests'>
): Promise<void> {
  if (!active) {
    return Promise.resolve()
  }
  if (active.steerCancel || active.cancelling) {
    return active.steerCancel ?? Promise.resolve()
  }
  active.cancelling = true
  channel.cancelIncomingRequests()
  active.steerCancel = channel.send().catch((error: unknown) => {
    // Only a cancel that reached the agent counts; a failed write may be asked again.
    active.cancelling = false
    active.steerCancel = undefined
    throw error
  })
  return active.steerCancel
}

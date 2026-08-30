/**
 * The one place a renderer-bound IPC rejection is read, so Electron's envelope is removed once.
 *
 * Electron names a rejected `ipcMain.handle` in the string it rejects with — "Error invoking remote
 * method '<channel>': <tail>" — and the renderer's ordinary idiom is to render `err.message`. That
 * idiom is correct everywhere else, so there is no per-call-site rule that separates the leaking
 * uses from the rest: the discriminator is whether the value crossed IPC, which is invisible at the
 * point it is rendered. Stripping here, where the envelope is created, is what makes the guarantee
 * hold for a call site nobody has written yet.
 *
 * The envelope is not lost, only demoted: it is logged here, against the channel that produced it,
 * before the message is narrowed. Preload is the last place it can be kept, because this rejection
 * does not reach the renderer as this object. `contextBridge` copies what crosses it, so a renderer
 * consumer receives a fresh plain `Error` carrying `message` and a `stack` regenerated from that
 * message — the prototype, own properties and object identity stop here, and so does the wrapped
 * form of the stack. Nothing is lost by narrowing in place that the bridge would not have dropped
 * anyway: an `ipcRenderer.invoke` rejection arrives already flattened to `message` and `stack`, its
 * own main-process class and properties gone one hop earlier.
 *
 * Measured across the real binary rather than reasoned about — see
 * `ipc-invoke-boundary-bridge.electron.test.ts`, which asserts the renderer's view.
 */

import { ipcRenderer } from 'electron'
import { stripIpcInvokeEnvelope } from '../shared/ipc-invoke-envelope'

/**
 * The rejection the renderer should see: the same error, carrying only the reason behind it.
 *
 * Left untouched when the envelope carried no readable reason — a handler that threw a message-less
 * error arrives as a bare class name, and an empty message renders as an empty toast, which is a
 * worse failure than the plumbing it replaces. Call sites that must never show plumbing already
 * branch on that case through `extractIpcErrorMessage`, which supplies copy this layer cannot know.
 */
export function readableInvokeRejection(rejection: unknown, channel: string): unknown {
  if (!(rejection instanceof Error)) {
    return rejection
  }
  const wrapped = rejection.message
  const reason = stripIpcInvokeEnvelope(wrapped)
  if (reason === null || reason === wrapped) {
    return rejection
  }
  console.warn(`[ipc] '${channel}' rejected; raw:`, wrapped, rejection.stack ?? '')
  rejection.message = reason
  return rejection
}

/**
 * `ipcRenderer.invoke` with the envelope stripped from whatever it rejects with.
 *
 * `T` is inferred from the binding's declared return type, so this is type-neutral at the 731 call
 * sites that adopt it: the preload surface keeps saying what each channel resolves to.
 */
export async function invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
  try {
    return (await ipcRenderer.invoke(channel, ...args)) as T
  } catch (rejection) {
    throw readableInvokeRejection(rejection, channel)
  }
}

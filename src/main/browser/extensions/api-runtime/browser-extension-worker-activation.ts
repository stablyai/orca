import { randomBytes } from 'node:crypto'
import { runBrowserExtensionNativePage } from './browser-extension-native-page'
import {
  isBrowserExtensionExecutionLive,
  type BrowserExtensionExecution
} from './browser-extension-execution-authority'

const pending = new WeakMap<BrowserExtensionExecution, Promise<void>>()

/** Only a current in-flight proof is shared; later calls must prove native readiness anew. */
export function activateBrowserExtensionWorker(
  execution: BrowserExtensionExecution
): Promise<void> {
  const existing = pending.get(execution)
  if (existing) {
    return existing
  }
  const ready = activate(execution)
  pending.set(execution, ready)
  const settled = (): void => {
    if (pending.get(execution) === ready) {
      pending.delete(execution)
    }
  }
  void ready.then(settled, settled)
  return ready
}

/** The native message wakes the current registration; its reply follows shim subscription setup. */
async function activate(execution: BrowserExtensionExecution): Promise<void> {
  const challenge = randomBytes(32).toString('hex')
  const ack = await runBrowserExtensionNativePage({
    session: execution.session,
    extensionId: execution.extensionId,
    signal: execution.controller.signal,
    code: `new Promise((resolve,reject)=>chrome.runtime.sendMessage({orcaExecutionActivation:${JSON.stringify(challenge)}},reply=>chrome.runtime.lastError?reject(new Error(chrome.runtime.lastError.message)):resolve(reply)))`
  })
  if (
    !isBrowserExtensionExecutionLive(execution) ||
    !ack ||
    typeof ack !== 'object' ||
    !('challenge' in ack) ||
    ack.challenge !== challenge ||
    !('token' in ack) ||
    ack.token !== execution.workerToken
  ) {
    throw new Error('The extension worker did not finish starting')
  }
}

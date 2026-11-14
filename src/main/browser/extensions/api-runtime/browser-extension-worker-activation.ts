import { randomBytes } from 'node:crypto'
import { runBrowserExtensionNativePage } from './browser-extension-native-page'
import { startBrowserExtensionWorker } from './browser-extension-worker-start'
import { ensureWorkerContext, type WorkerContext } from './browser-extension-contexts'
import { getChromeExtensionOrigin } from '../../../../shared/browser/extensions/browser-extension-url'
import {
  isBrowserExtensionExecutionLive,
  type BrowserExtensionExecution
} from './browser-extension-execution-authority'

export type BrowserExtensionWorkerProof = {
  execution: BrowserExtensionExecution
  context: WorkerContext
  worker: Electron.ServiceWorkerMain
  run: AbortController
  stream: NonNullable<WorkerContext['stream']>
}

export function isBrowserExtensionWorkerProofLive(proof: BrowserExtensionWorkerProof): boolean {
  const { execution, context, worker, run, stream } = proof
  return (
    isBrowserExtensionExecutionLive(execution) &&
    execution.host.workers.get(execution.extensionId) === context &&
    context.run === run &&
    !run.signal.aborted &&
    context.running === worker &&
    !worker.isDestroyed() &&
    context.stream === stream &&
    stream.published &&
    !stream.controller.signal.aborted &&
    !!execution.session.serviceWorkers.getAllRunning()[worker.versionId]
  )
}

const pending = new WeakMap<BrowserExtensionExecution, Promise<BrowserExtensionWorkerProof>>()

/** Only a current in-flight proof is shared; later calls must prove native readiness anew. */
export function activateBrowserExtensionWorker(
  execution: BrowserExtensionExecution
): Promise<BrowserExtensionWorkerProof> {
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
async function activate(
  execution: BrowserExtensionExecution
): Promise<BrowserExtensionWorkerProof> {
  const context = ensureWorkerContext(
    execution.host,
    execution.extensionId,
    `${getChromeExtensionOrigin(execution.extensionId)}/`
  )
  const worker = await startBrowserExtensionWorker(execution, context)
  const run = context.run
  if (!run || run.signal.aborted) {
    throw new Error('Extension worker is unavailable')
  }
  // This application request budget does not limit native worker continuation after delivery.
  const deadline = Date.now() + 5 * 60 * 1000
  const signal = AbortSignal.any([
    execution.controller.signal,
    run.signal,
    ...(context.stream ? [context.stream.controller.signal] : [])
  ])
  const challenge = randomBytes(32).toString('hex')
  const ack = await runBrowserExtensionNativePage({
    session: execution.session,
    extensionId: execution.extensionId,
    signal,
    deadlineAt: deadline,
    code: `new Promise((resolve,reject)=>chrome.runtime.sendMessage({orcaExecutionActivation:${JSON.stringify(challenge)}},reply=>chrome.runtime.lastError?reject(new Error(chrome.runtime.lastError.message)):resolve(reply)))`
  })
  if (
    !isBrowserExtensionExecutionLive(execution) ||
    signal.aborted ||
    context.run !== run ||
    context.running !== worker ||
    !execution.session.serviceWorkers.getAllRunning()[worker.versionId] ||
    execution.host.workers.get(execution.extensionId) !== context ||
    !context.stream?.published ||
    !ack ||
    typeof ack !== 'object' ||
    !('challenge' in ack) ||
    ack.challenge !== challenge ||
    !('token' in ack) ||
    ack.token !== execution.workerToken ||
    !('connectionId' in ack) ||
    ack.connectionId !== context.stream.connectionId
  ) {
    throw new Error('The extension worker did not finish starting')
  }
  return { execution, context, worker, run, stream: context.stream }
}

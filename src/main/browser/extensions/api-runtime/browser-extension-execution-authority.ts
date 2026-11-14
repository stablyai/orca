import { randomBytes } from 'node:crypto'
import { getHostSessionState, type HostSessionState } from './browser-extension-contexts'

export type BrowserExtensionExecution = {
  session: Electron.Session
  extensionId: string
  host: HostSessionState
  controller: AbortController
  workerToken: string
  bootstrap: string
  contentToken: string
  fileNonce: string
  contentScriptFile: string
  preparedDirectory?: string
  release?: () => Promise<void>
  retired?: Promise<void>
  operations: Set<Promise<unknown>>
}

const executions = new WeakMap<Electron.Session, Map<string, BrowserExtensionExecution>>()
const workers = new Map<string, BrowserExtensionExecution>()
const bootstraps = new Map<string, BrowserExtensionExecution>()
const content = new Map<string, BrowserExtensionExecution>()

export function getBrowserExtensionExecution(
  session: Electron.Session,
  extensionId: string
): BrowserExtensionExecution | undefined {
  return executions.get(session)?.get(extensionId)
}

export function isBrowserExtensionExecutionLive(execution: BrowserExtensionExecution): boolean {
  return (
    !execution.controller.signal.aborted &&
    getHostSessionState(execution.session) === execution.host &&
    getBrowserExtensionExecution(execution.session, execution.extensionId) === execution
  )
}

export function retireBrowserExtensionExecution(
  session: Electron.Session,
  extensionId: string
): Promise<void> {
  const owned = executions.get(session)
  const execution = owned?.get(extensionId)
  if (!execution) {
    return Promise.resolve()
  }
  owned?.delete(extensionId)
  workers.delete(execution.workerToken)
  bootstraps.delete(execution.bootstrap)
  content.delete(execution.contentToken)
  execution.controller.abort()
  execution.retired = whenBrowserExtensionExecutionSettled(execution).then(() =>
    execution.release?.()
  )
  return execution.retired
}

/** Called only inside the existing serialized native load, before its first original instruction. */
export function beginBrowserExtensionExecution(
  session: Electron.Session,
  extensionId: string,
  signal: AbortSignal
): BrowserExtensionExecution {
  signal.throwIfAborted()
  const host = getHostSessionState(session)
  if (!host) {
    throw new Error('Browser extension session is unavailable')
  }
  retireBrowserExtensionExecution(session, extensionId)
  const fileNonce = randomBytes(16).toString('hex')
  const execution: BrowserExtensionExecution = {
    session,
    extensionId,
    host,
    controller: new AbortController(),
    workerToken: randomBytes(32).toString('hex'),
    bootstrap: randomBytes(32).toString('hex'),
    contentToken: randomBytes(32).toString('hex'),
    fileNonce,
    contentScriptFile: `orca-content-script-api-${fileNonce}.js`,
    operations: new Set()
  }
  let owned = executions.get(session)
  if (!owned) {
    owned = new Map()
    executions.set(session, owned)
  }
  owned.set(extensionId, execution)
  workers.set(execution.workerToken, execution)
  bootstraps.set(execution.bootstrap, execution)
  content.set(execution.contentToken, execution)
  const cancel = (): void => {
    if (getBrowserExtensionExecution(session, extensionId) === execution) {
      retireBrowserExtensionExecution(session, extensionId)
    }
  }
  signal.addEventListener('abort', cancel, { once: true })
  execution.controller.signal.addEventListener(
    'abort',
    () => signal.removeEventListener('abort', cancel),
    { once: true }
  )
  if (signal.aborted) {
    cancel()
  }
  return execution
}

export function trackBrowserExtensionExecutionOperation<T>(
  execution: BrowserExtensionExecution,
  run: () => Promise<T>
): Promise<T> {
  execution.controller.signal.throwIfAborted()
  const operation = Promise.resolve().then(() => {
    execution.controller.signal.throwIfAborted()
    return run()
  })
  execution.operations.add(operation)
  void operation.finally(() => execution.operations.delete(operation)).catch(() => {})
  return operation
}

/** Retirement prevents admission before taking this snapshot. */
export async function whenBrowserExtensionExecutionSettled(
  execution: BrowserExtensionExecution
): Promise<void> {
  await Promise.allSettled(execution.operations)
}

export function browserExtensionWorkerAuthority(
  token: string,
  session: Electron.Session,
  extensionId: string
): BrowserExtensionExecution | null {
  const execution = workers.get(token)
  return execution &&
    execution.session === session &&
    execution.extensionId === extensionId &&
    isBrowserExtensionExecutionLive(execution)
    ? execution
    : null
}

export function browserExtensionBootstrapAuthority(
  bootstrap: string,
  session: Electron.Session
): BrowserExtensionExecution | null {
  const execution = bootstraps.get(bootstrap)
  return execution && execution.session === session && isBrowserExtensionExecutionLive(execution)
    ? execution
    : null
}

export function browserExtensionContentAuthority(
  token: string,
  session: Electron.Session
): BrowserExtensionExecution | null {
  const execution = content.get(token)
  return execution && execution.session === session && isBrowserExtensionExecutionLive(execution)
    ? execution
    : null
}

import {
  COPILOT_MAX_DOCUMENT_CHARS,
  type CopilotInlineCompletionArgs,
  type CopilotInlineCompletionResult,
  type CopilotOpenDocumentArgs,
  type CopilotOpenDocumentResult,
  type CopilotSignInResult,
  type CopilotStatus
} from '../../shared/copilot-inline-completion-types'
import { connectCopilotServer, type CopilotServerConnection } from './copilot-server-connection'
import type { CopilotServerProcess } from './copilot-server-process'
import { createCopilotOpenDocuments } from './copilot-open-documents'
import { createCopilotSignIn } from './copilot-sign-in'

import {
  buildCopilotInitializeParams,
  isHttpsUrl,
  isRecord,
  parseCheckStatusResult,
  parseCopilotStatusNotification
} from './copilot-protocol'

// Why: keep a doc-less server briefly for tab switches, but don't hold a node process open indefinitely.
const IDLE_SHUTDOWN_MS = 3 * 60_000

export type CopilotLanguageServerDeps = {
  editorVersion: string
  /** Absolute path of copilot-language-server, or null when it is not installed. */
  locateServer: () => Promise<string | null>
  spawnServer: (program: string) => CopilotServerProcess
  openExternal: (url: string) => void
  copyToClipboard: (text: string) => void
  onStatus: (status: CopilotStatus) => void
}

export function createCopilotLanguageServer(deps: CopilotLanguageServerDeps) {
  let status: CopilotStatus = {
    installed: false,
    kind: null,
    message: '',
    busy: false,
    user: null,
    signInFailed: false
  }
  // null until the first checkStatus answer; false keeps the server unspawned (inert).
  let authenticated: boolean | null = null
  let connectionPromise: Promise<CopilotServerConnection | null> | null = null
  let activeConnection: CopilotServerConnection | null = null
  let authCheck: Promise<void> | null = null
  // Set once an open found checkStatus unanswered; the next open retries it instead of respawning.
  let authUnverified = false
  const openDocuments = createCopilotOpenDocuments()
  let idleTimer: NodeJS.Timeout | null = null

  function updateStatus(patch: Partial<CopilotStatus>): void {
    status = { ...status, ...patch }
    deps.onStatus(status)
  }

  function clearIdleTimer(): void {
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
  }

  function disposeIfIdle(): void {
    if (openDocuments.count() === 0 && !signInFlow.isActive()) {
      activeConnection?.dispose()
    }
  }

  function scheduleIdleShutdown(): void {
    clearIdleTimer()
    idleTimer = setTimeout(disposeIfIdle, IDLE_SHUTDOWN_MS)
    idleTimer.unref?.()
  }

  async function refreshAuth(connection: CopilotServerConnection): Promise<void> {
    try {
      const { signedIn, user } = parseCheckStatusResult(await connection.request('checkStatus', {}))
      authenticated = signedIn
      updateStatus({
        installed: true,
        user: signedIn ? user : null,
        ...(signedIn ? {} : { kind: 'Error' as const })
      })
    } catch {
      // Status stays whatever didChangeStatus last reported.
    }
  }

  // Why: concurrent opens share one checkStatus instead of each racing its own.
  function recheckAuth(connection: CopilotServerConnection): Promise<void> {
    authCheck ??= refreshAuth(connection).finally(() => {
      authCheck = null
    })
    return authCheck
  }

  function handleNotification(method: string, params: unknown): void {
    if (method !== 'didChangeStatus') {
      return
    }
    const parsed = parseCopilotStatusNotification(params)
    if (!parsed) {
      return
    }
    updateStatus({ installed: true, ...parsed })
    // Why: a finished device flow surfaces only as a Normal status; fetch the login.
    if (parsed.kind === 'Normal' && !status.user && activeConnection) {
      void refreshAuth(activeConnection)
    }
  }

  function handleRequest(method: string, params: unknown): unknown {
    if (method !== 'window/showDocument') {
      return undefined
    }
    const uri = isRecord(params) ? params.uri : undefined
    // Why: a server asking to open pages outside a user-started sign-in is not expected.
    if (signInFlow.isActive() && isHttpsUrl(uri)) {
      deps.openExternal(uri)
      return { success: true }
    }
    return { success: false }
  }

  function handleClosed(connection: CopilotServerConnection): void {
    if (activeConnection !== connection) {
      return
    }
    activeConnection = null
    connectionPromise = null
    authUnverified = false
    openDocuments.clear()
    clearIdleTimer()
  }

  async function startConnection(): Promise<CopilotServerConnection | null> {
    const program = await deps.locateServer()
    if (!program) {
      if (status.installed) {
        updateStatus({ installed: false })
      }
      return null
    }
    let connection: CopilotServerConnection
    try {
      connection = connectCopilotServer({
        child: deps.spawnServer(program),
        initializeParams: buildCopilotInitializeParams(deps.editorVersion),
        // Why: the server waits for an initial configuration push before serving completions.
        onReady: (ready) => ready.notify('workspace/didChangeConfiguration', { settings: {} }),
        onNotification: handleNotification,
        onRequest: handleRequest,
        onClosed: () => handleClosed(connection)
      })
    } catch {
      return null
    }
    activeConnection = connection
    if (connection.isDisposed()) {
      handleClosed(connection)
      return null
    }
    try {
      await connection.ready
      await refreshAuth(connection)
    } catch {
      connection.dispose()
      handleClosed(connection)
      return null
    }
    scheduleIdleShutdown()
    return connection.isDisposed() ? null : connection
  }

  function ensureConnection(): Promise<CopilotServerConnection | null> {
    if (!connectionPromise) {
      const promise = startConnection()
      connectionPromise = promise
      void promise.then((connection) => {
        if (!connection && connectionPromise === promise) {
          connectionPromise = null
        }
      })
    }
    return connectionPromise
  }

  const signInFlow = createCopilotSignIn({
    openExternal: deps.openExternal,
    copyToClipboard: deps.copyToClipboard,
    ensureConnection,
    refreshAuth,
    currentUser: () => status.user,
    onFinishFailed: () => updateStatus({ signInFailed: true }),
    // Why: a server nothing uses (no documents, not signed in) should not linger after the flow ends.
    onSettled: () => {
      if (openDocuments.count() > 0) {
        return
      }
      if (authenticated) {
        scheduleIdleShutdown()
      } else {
        disposeIfIdle()
      }
    }
  })

  async function getStatus(): Promise<CopilotStatus> {
    const installed = (await deps.locateServer()) !== null
    if (installed !== status.installed) {
      status = { ...status, installed }
    }
    return status
  }

  async function signIn(): Promise<CopilotSignInResult> {
    if (status.signInFailed) {
      updateStatus({ signInFailed: false })
    }
    return signInFlow.signIn()
  }

  async function openDocument(args: CopilotOpenDocumentArgs): Promise<CopilotOpenDocumentResult> {
    const none: CopilotOpenDocumentResult = { fileUri: null }
    if (authenticated === false || args.text.length > COPILOT_MAX_DOCUMENT_CHARS) {
      return none
    }
    const connection = await ensureConnection()
    if (!connection) {
      return none
    }
    if (authenticated === null && authUnverified) {
      await recheckAuth(connection)
    }
    if (connection.isDisposed()) {
      return none
    }
    if (authenticated === null) {
      // Why: an unanswered checkStatus is not "signed out"; keep the server so opens don't respawn it in a loop.
      authUnverified = true
      return none
    }
    if (!authenticated) {
      // Why: not signed in means nothing may run; drop the process spawned to find that out.
      disposeIfIdle()
      return none
    }
    clearIdleTimer()
    return { fileUri: openDocuments.open(connection, args) }
  }

  function changeDocument(fileUri: string, text: string): void {
    if (activeConnection && text.length <= COPILOT_MAX_DOCUMENT_CHARS) {
      openDocuments.change(activeConnection, fileUri, text)
    }
  }

  function closeDocument(fileUri: string): void {
    if (
      activeConnection &&
      openDocuments.close(activeConnection, fileUri) &&
      openDocuments.count() === 0
    ) {
      scheduleIdleShutdown()
    }
  }

  async function inlineCompletion(
    args: CopilotInlineCompletionArgs
  ): Promise<CopilotInlineCompletionResult> {
    const version = openDocuments.versionOf(args.fileUri)
    if (!activeConnection || version === null) {
      return { opened: false, result: null }
    }
    const result = await activeConnection.request('textDocument/inlineCompletion', {
      // Why: the server drops requests whose version differs from what it holds, and only main knows it.
      textDocument: { uri: args.fileUri, version },
      position: args.position,
      // LSP InlineCompletionTriggerKind: Invoked = 1, Automatic = 2.
      context: { triggerKind: args.trigger === 'explicit' ? 1 : 2 },
      formattingOptions: args.formattingOptions
    })
    return { opened: true, result }
  }

  function dispose(): void {
    clearIdleTimer()
    activeConnection?.dispose()
  }

  return {
    getStatus,
    openDocument,
    changeDocument,
    closeDocument,
    inlineCompletion,
    signIn,
    dispose
  }
}

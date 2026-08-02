import { CodexControlledSessionStateStore } from './codex-controlled-session-state'
import { submitControlledInitialTurn } from './codex-controlled-initial-turn'
import { CodexUnixAppServerClient } from './codex-unix-app-server-client'
import {
  assertControlledServerIdentity,
  buildControlledVisibleResumeCommand,
  failControlledTerminalIdentity,
  getControlledLaunchFingerprint,
  getControlledStatePath,
  type ControlledCodexCommand,
  type ControlledCodexServer,
  type CodexControlledSessionLaunch
} from './codex-controlled-session-launch'
import type {
  CodexControlledNewSessionLaunch,
  CodexControlledSessionIdentity,
  CodexControlledSessionManagerOptions
} from './codex-controlled-session-manager'

export type ControlledCodexSession = {
  launch: CodexControlledSessionLaunch
  socketPath: string
  server: ControlledCodexServer
  client: CodexUnixAppServerClient
  state: CodexControlledSessionStateStore
  terminal: CodexControlledSessionIdentity
  missing: boolean
  terminalClosed: boolean
}

export async function submitControlledInitialPrompt(
  session: ControlledCodexSession,
  input: CodexControlledNewSessionLaunch,
  assertCanSubmit: (session: ControlledCodexSession) => void
): Promise<void> {
  if (input.prompt?.trim()) {
    await submitControlledInitialTurn(session, input.operationId, input.prompt, () =>
      assertCanSubmit(session)
    )
  }
}

export async function connectControlledCodexClient(
  input: CodexControlledSessionLaunch,
  socketPath: string
): Promise<CodexUnixAppServerClient> {
  const client = await CodexUnixAppServerClient.connect(socketPath)
  try {
    assertControlledServerIdentity(client.initializeResult, input.codexHome)
    return client
  } catch (error) {
    client.close()
    throw error
  }
}

export async function createReadyControlledTerminal(
  options: CodexControlledSessionManagerOptions,
  input: CodexControlledSessionLaunch,
  socketPath: string,
  command: ControlledCodexCommand,
  onCreated: (identity: CodexControlledSessionIdentity) => void
): Promise<CodexControlledSessionIdentity> {
  const terminal = await options.createVisibleTerminal({
    worktreeSelector: input.worktreeSelector,
    command: buildControlledVisibleResumeCommand(input, socketPath, command),
    cwd: input.cwd,
    env: { CODEX_HOME: input.codexHome },
    conversationId: input.conversationId,
    threadId: input.threadId,
    presentation: 'focused'
  })
  const cleanupIdentity: CodexControlledSessionIdentity = {
    conversationId: input.conversationId,
    threadId: input.threadId,
    terminalHandle: terminal.handle,
    terminalPtyId: terminal.ptyId ?? null,
    terminalTabId: terminal.tabId ?? '',
    terminalPaneKey: terminal.paneKey ?? '',
    worktreeId: terminal.worktreeId ?? ''
  }
  let ownedByCaller = false
  try {
    if (terminal.surface !== 'visible') {
      throw new Error('controlled Codex visible terminal was not renderer-adopted')
    }
    const identity: CodexControlledSessionIdentity = {
      ...cleanupIdentity,
      terminalTabId: terminal.tabId ?? failControlledTerminalIdentity('tab'),
      terminalPaneKey: terminal.paneKey ?? failControlledTerminalIdentity('pane'),
      worktreeId: terminal.worktreeId ?? failControlledTerminalIdentity('workspace')
    }
    onCreated(identity)
    ownedByCaller = true
    return options.waitForVisibleTerminal(identity)
  } catch (error) {
    if (!ownedByCaller) {
      try {
        await options.closeVisibleTerminal(cleanupIdentity)
      } catch (cleanupError) {
        Object.assign(toControlledSessionError(error), { cleanupError })
      }
    }
    throw error
  }
}

export function createControlledCodexSession(params: {
  options: CodexControlledSessionManagerOptions
  launch: CodexControlledSessionLaunch
  socketPath: string
  server: ControlledCodexServer
  client: CodexUnixAppServerClient
  terminal: CodexControlledSessionIdentity
  onNotification: (
    session: ControlledCodexSession,
    method: string,
    notification: Record<string, unknown>
  ) => void
  onMissing: (conversationId: string) => void
}): ControlledCodexSession {
  const session: ControlledCodexSession = {
    launch: params.launch,
    socketPath: params.socketPath,
    server: params.server,
    client: params.client,
    terminal: params.terminal,
    state: new CodexControlledSessionStateStore(
      getControlledStatePath(params.options.stateRoot, params.launch.conversationId),
      {
        conversationId: params.launch.conversationId,
        threadId: params.launch.threadId,
        accountId: params.launch.accountId,
        launchFingerprint: getControlledLaunchFingerprint(params.launch)
      }
    ),
    missing: false,
    terminalClosed: false
  }
  params.client.onNotification((method, notification) =>
    params.onNotification(session, method, notification)
  )
  params.server.process.once('exit', () => {
    session.missing = true
    params.onMissing(params.launch.conversationId)
  })
  return session
}

export function toControlledSessionError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

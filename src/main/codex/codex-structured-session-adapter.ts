import {
  AgentSessionPreSpawnError,
  type AgentSessionAcquisition,
  type StructuredAgentSessionAcquireInput,
  type StructuredAgentSessionAdapter
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'
import { openCodexAppServerConnection } from './codex-app-server-connection'
import { codexProcessIdentity, codexProviderHandleLink } from './codex-structured-owner-identity'
import { buildCodexStructuredChildEnvironment } from './codex-structured-child-environment'
import { openCodexThread } from './codex-structured-thread-open'
import { supportsCodexStructuredLocation } from './codex-structured-location-support'
import { closeCodexPublishedSession } from './codex-structured-session-close'
import { CodexStructuredSessionControl } from './codex-structured-session-control'
import {
  reportedCodexThreadOptions,
  restoredCodexSessionOptions
} from './codex-structured-session-options'
import {
  cancelCodexAcquisitionAttempt,
  CodexAcquisitionRegistry,
  type CodexAcquisitionAttempt,
  type CodexSession,
  type CodexStructuredSessionAdapterDeps
} from './codex-structured-session-state'

export type {
  CodexStructuredLaunch,
  CodexStructuredSessionAdapterDeps,
  CodexStructuredSessionEvent
} from './codex-structured-session-state'

export class CodexStructuredSessionAdapter implements StructuredAgentSessionAdapter {
  private readonly sessions = new Map<string, CodexSession>()
  private readonly acquisitions = new CodexAcquisitionRegistry()
  private readonly control: CodexStructuredSessionControl

  constructor(private readonly deps: CodexStructuredSessionAdapterDeps) {
    this.control = new CodexStructuredSessionControl(this.sessions, deps)
  }

  supportsLocation = supportsCodexStructuredLocation

  async acquire(input: StructuredAgentSessionAcquireInput): Promise<AgentSessionAcquisition> {
    const sessionId = input.identity.sessionId
    const { previousAttempt, attempt } = this.acquisitions.start(sessionId)
    const acquisition = attempt.window
    let unpublishedIsolatedHome: string | null = null
    let primaryThreadId =
      input.identity.providerHandle.kind === 'codex' ? input.identity.providerHandle.threadId : null
    const translator = input.events
      ? createCodexJournalTranslator({
          sink: input.events,
          primaryThreadId: () => primaryThreadId,
          bindPromptItemId: (journalItemId, threadId, promptKey) =>
            acquisition.prompts.bindJournalItemId(journalItemId, threadId, promptKey)
        })
      : null
    const open = this.deps.openConnection ?? openCodexAppServerConnection

    try {
      await cancelCodexAcquisitionAttempt(previousAttempt)
      this.acquisitions.assertCurrent(sessionId, attempt)
      // Re-acquisition is a new child and a new trust epoch. Retire admitted
      // work from the previous child before resolving credentials for this one.
      this.deps.writeAuthority?.revokeSession(sessionId)
      await closeCodexPublishedSession(
        this.sessions,
        sessionId,
        this.deps.onEvent,
        this.deps.releaseStructuredWriteHome
      )
      this.acquisitions.assertCurrent(sessionId, attempt)
      if (this.deps.writeAuthority && !this.deps.releaseStructuredWriteHome) {
        throw new AgentSessionPreSpawnError(
          new Error('structured write authority requires an isolated-home release provider')
        )
      }
      const launch = await this.deps
        .resolveLaunch({ identity: input.identity })
        .catch((error: unknown) => {
          throw new AgentSessionPreSpawnError(error)
        })
      if (this.deps.writeAuthority) {
        // The resolver may already have created this home. Track it before
        // validating the rest of the launch so every fail-closed branch reaps it.
        unpublishedIsolatedHome = launch.isolatedHomePath ?? null
        if (launch.effectIsolation !== 'local-structured-write') {
          throw new AgentSessionPreSpawnError(
            new Error('structured write authority requires an effect-isolated Codex launch')
          )
        }
        if (!launch.isolatedHomePath || launch.codexHome !== launch.isolatedHomePath) {
          throw new AgentSessionPreSpawnError(
            new Error('structured write authority requires an isolated Codex home')
          )
        }
        await this.deps.writeAuthority
          .bindSession(sessionId, launch.cwd)
          .catch((error: unknown) => {
            throw new AgentSessionPreSpawnError(error)
          })
      }
      this.acquisitions.assertCurrent(sessionId, attempt)
      const connection = await open(
        {
          command: launch.command,
          args: launch.args,
          env: buildCodexStructuredChildEnvironment(launch, input.spawnToken)
        },
        {
          onNotification: (method, params) =>
            this.deliver(acquisition, sessionId, () =>
              this.control.handleNotification(sessionId, method, params)
            ),
          onServerRequest: (request) =>
            this.deliver(acquisition, sessionId, () => {
              void this.control.handleServerRequest(sessionId, request).catch((error: unknown) => {
                acquisition.connection?.respondWithError(
                  request.id,
                  -32000,
                  error instanceof Error ? error.message : String(error)
                )
              })
            }),
          onUnhandledFrame: (kind, payload) =>
            this.deliver(acquisition, sessionId, () =>
              this.control.handleUnhandledFrame(sessionId, kind, payload)
            ),
          onExit: (error) => this.handleExit(sessionId, acquisition, error)
        }
      )
      acquisition.connection = connection
      this.acquisitions.assertCurrent(sessionId, attempt)
      const opened = await openCodexThread(connection, launch, this.deps.requestTimeoutMs)
      this.acquisitions.assertCurrent(sessionId, attempt)
      primaryThreadId = opened.threadId
      const process = await codexProcessIdentity(
        { ...input, pid: connection.pid },
        this.deps.readProcessStartTime
      )
      this.acquisitions.assertCurrent(sessionId, attempt)
      const acquired: AgentSessionAcquisition = {
        process,
        link: codexProviderHandleLink({
          threadId: opened.threadId,
          resumed: launch.resumeThreadId !== null,
          fence: input.fence,
          linkId: this.deps.mintLinkId?.(),
          observedAt: this.deps.now?.() ?? Date.now()
        })
      }
      // Publish only after every promised identity is proven and this attempt still owns the child.
      if (connection.closed) {
        throw new Error(`codex app-server for session ${sessionId} exited while being acquired`)
      }
      this.acquisitions.assertCurrent(sessionId, attempt)
      this.acquisitions.deleteIfCurrent(sessionId, attempt)
      this.sessions.set(sessionId, {
        connection,
        threadId: opened.threadId,
        historyPath: opened.historyPath,
        prompts: acquisition.prompts,
        options: restoredCodexSessionOptions(input.options),
        reportedOptions: reportedCodexThreadOptions(opened),
        turnIdWaiters: [],
        translator,
        isolatedHomePath: launch.isolatedHomePath ?? null
      })
      unpublishedIsolatedHome = null
      for (const event of acquisition.drain()) {
        event()
      }
      return acquired
    } catch (error) {
      this.acquisitions.deleteIfCurrent(sessionId, attempt)
      const published = this.sessions.get(sessionId)
      if (!published || published.connection === acquisition.connection) {
        this.deps.writeAuthority?.revokeSession(sessionId)
      }
      // Reap this attempt's child only. A replacement already published for the
      // same session keeps running.
      if (published?.connection === acquisition.connection) {
        await closeCodexPublishedSession(
          this.sessions,
          sessionId,
          this.deps.onEvent,
          this.deps.releaseStructuredWriteHome
        )
      } else {
        translator?.dispose()
        try {
          await acquisition.connection?.close()
        } finally {
          if (unpublishedIsolatedHome && this.deps.releaseStructuredWriteHome) {
            await this.deps
              .releaseStructuredWriteHome(sessionId, unpublishedIsolatedHome)
              .catch((cleanupError: unknown) => {
                this.deps.onStructuredWriteHomeError?.({
                  sessionId,
                  error: cleanupError
                })
              })
          }
        }
      }
      throw error
    } finally {
      attempt.finish()
    }
  }

  /** Buffers pre-publication events and drops events from superseded children. */
  private deliver(
    acquisition: CodexAcquisitionAttempt['window'],
    sessionId: string,
    event: () => void
  ): void {
    if (acquisition.buffer(event)) {
      return
    }
    if (this.sessions.get(sessionId)?.connection === acquisition.connection) {
      event()
    }
  }

  /** Only the current connection may retire a session. */
  private handleExit(
    sessionId: string,
    acquisition: CodexAcquisitionAttempt['window'],
    error: Error
  ): void {
    acquisition.prompts.clear()
    const session = this.sessions.get(sessionId)
    if (!session || session.connection !== acquisition.connection) {
      return
    }
    this.sessions.delete(sessionId)
    this.deps.writeAuthority?.revokeSession(sessionId)
    try {
      this.control.emit(session, { type: 'ended', sessionId, reason: error.message })
    } finally {
      session.translator?.dispose()
      if (session.isolatedHomePath && this.deps.releaseStructuredWriteHome) {
        void this.deps
          .releaseStructuredWriteHome(sessionId, session.isolatedHomePath)
          .catch((cleanupError: unknown) => {
            this.deps.onStructuredWriteHomeError?.({ sessionId, error: cleanupError })
          })
      }
    }
  }

  bindPromptItemId = (...args: Parameters<CodexStructuredSessionControl['bindPromptItemId']>) =>
    this.control.bindPromptItemId(...args)
  dispatch = (...args: Parameters<CodexStructuredSessionControl['dispatch']>) =>
    this.control.dispatch(...args)
  cancelTurn = (...args: Parameters<CodexStructuredSessionControl['cancelTurn']>) =>
    this.control.cancelTurn(...args)
  answerPrompt = (...args: Parameters<CodexStructuredSessionControl['answerPrompt']>) =>
    this.control.answerPrompt(...args)
  setOption = (...args: Parameters<CodexStructuredSessionControl['setOption']>) =>
    this.control.setOption(...args)
  readOptions = (...args: Parameters<CodexStructuredSessionControl['readOptions']>) =>
    this.control.readOptions(...args)
  historyFilePath = (...args: Parameters<CodexStructuredSessionControl['historyFilePath']>) =>
    this.control.historyFilePath(...args)

  /** Reaps one session's child. The proven handle chain is already durable, so
   *  a graceful close loses nothing. */
  async closeSession(sessionId: string): Promise<void> {
    this.deps.writeAuthority?.revokeSession(sessionId)
    const attempt = this.acquisitions.get(sessionId)
    if (attempt) {
      attempt.cancelled = true
      await attempt.window.connection?.close()
      await attempt.finished
    }
    await closeCodexPublishedSession(
      this.sessions,
      sessionId,
      this.deps.onEvent,
      this.deps.releaseStructuredWriteHome
    )
  }

  async closeAll(): Promise<void> {
    this.acquisitions.close()
    while (this.sessions.size > 0 || this.acquisitions.size > 0) {
      const sessionIds = new Set([...this.sessions.keys(), ...this.acquisitions.sessionIds()])
      await Promise.all([...sessionIds].map((sessionId) => this.closeSession(sessionId)))
    }
  }

  releaseAcquisition = (input: { sessionId: string }): Promise<void> =>
    this.closeSession(input.sessionId)
}

import { randomUUID } from 'node:crypto'
import { cancelProcessAcquisition } from '../../shared/child-process/cancel-process-acquisition'
import {
  openCodexAppServerConnection,
  type CodexAppServerConnection,
  type CodexAppServerLaunch
} from './codex-app-server-connection'
import { isCodexAppServerHandshakeExitUnprovenError } from './codex-app-server-handshake-exit-proof'
import {
  createCodexNamingTurnCollector,
  generateAndSetCodexConversationName,
  type CodexConversationNameGeneration,
  type CodexConversationNameOutcome
} from './codex-conversation-name-generation'
import { codexConversationNameCapabilityKey } from './codex-conversation-name-capability'
import { CODEX_SPAWN_TOKEN_ENV } from './codex-structured-owner-identity'

const NAMING_TIMEOUT_MS = 60_000

export class CodexConversationNamingTask {
  private connection: CodexAppServerConnection | null = null
  private cancelled = false
  /** A model turn was committed, so the caller must settle even on rejection. */
  billedTurn = false
  private exitProven = false
  private finishAcquisition = (): void => {}
  private readonly acquired = new Promise<void>((resolve) => {
    this.finishAcquisition = resolve
  })
  private interrupt = (): void => {}
  private readonly interrupted = new Promise<never>((_resolve, reject) => {
    this.interrupt = () => reject(new Error('Codex conversation naming cancelled'))
  })
  private readonly collector = createCodexNamingTurnCollector(NAMING_TIMEOUT_MS)
  private expiry: ReturnType<typeof setTimeout> | undefined
  readonly result: Promise<CodexConversationNameOutcome>

  constructor(input: {
    launch: CodexAppServerLaunch
    openConnection?: typeof openCodexAppServerConnection
    generation: Omit<
      CodexConversationNameGeneration,
      'connection' | 'collector' | 'isCancelled' | 'capabilityKey' | 'onTurnStarted'
    >
    timeoutMs?: number
    onError?: (scope: string, error: unknown) => void
  }) {
    this.expiry = setTimeout(() => {
      void this.close().catch((error: unknown) => input.onError?.('close-naming-process', error))
    }, input.timeoutMs ?? NAMING_TIMEOUT_MS)
    this.expiry.unref?.()
    this.result = this.run(input).finally(async () => {
      clearTimeout(this.expiry)
      this.collector.dispose()
      if (!(await this.close())) {
        input.onError?.(
          'close-naming-process',
          new Error('Codex naming process exit was not proven')
        )
      }
    })
  }

  private async run(input: {
    launch: CodexAppServerLaunch
    openConnection?: typeof openCodexAppServerConnection
    generation: Omit<
      CodexConversationNameGeneration,
      'connection' | 'collector' | 'isCancelled' | 'capabilityKey' | 'onTurnStarted'
    >
  }): Promise<CodexConversationNameOutcome> {
    // Cancellation can precede the handshake, but ownership must survive its rejection.
    const opening = (input.openConnection ?? openCodexAppServerConnection)(
      {
        ...input.launch,
        env: { ...input.launch.env, [CODEX_SPAWN_TOKEN_ENV]: randomUUID() }
      },
      {
        onConnection: (connection) => {
          this.connection = connection
        },
        onNotification: (method, params) => this.collector.handle(method, params),
        onServerRequest: (request) =>
          this.connection?.respondWithError(
            request.id,
            -32001,
            'Orca does not run tools when naming a conversation'
          ),
        onExit: () => this.collector.handle('error', {})
      }
    )
      .then((connection) => {
        this.connection = connection
        return connection
      })
      .catch((error: unknown) => {
        if (isCodexAppServerHandshakeExitUnprovenError(error)) {
          this.connection = error.connection
        }
        throw error
      })
      .finally(() => this.finishAcquisition())
    const connection = await Promise.race([opening, this.interrupted])
    if (this.cancelled) {
      throw new Error('Codex conversation naming cancelled')
    }
    const request: CodexAppServerConnection['request'] = (...args) => {
      if (this.cancelled) {
        return Promise.reject(new Error('Codex conversation naming cancelled'))
      }
      return Promise.race([connection.request(...args), this.interrupted])
    }
    return generateAndSetCodexConversationName({
      ...input.generation,
      capabilityKey: codexConversationNameCapabilityKey(input.launch),
      onTurnStarted: () => {
        this.billedTurn = true
      },
      connection: { request },
      collector: this.collector,
      isCancelled: () => this.cancelled
    })
  }

  close(): Promise<boolean> {
    clearTimeout(this.expiry)
    return cancelProcessAcquisition({
      cancel: () => {
        this.cancelled = true
        this.collector.dispose()
        this.interrupt()
      },
      connection: () => this.connection,
      exitProven: () => this.exitProven,
      finished: this.acquired
    }).then((stopped) => {
      if (stopped) {
        this.exitProven = true
      }
      return stopped
    })
  }
}

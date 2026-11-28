import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StructuredAgentCommandSettings } from '../../../native-chat/agent-launch/structured-agent-command-resolution'
import { spawnZcodeAppServerConnection } from '../../../zcode/app-server/zcode-app-server-connection'
import type { ZcodeAppServerConnection } from '../../../zcode/app-server/zcode-app-server-connection-types'
import { zcodeHeadlessLaunch } from '../launch/zcode-headless-launch'
import { zcodeDesktopEnvKeys } from '../launch/zcode-structured-launch-resolution'
import {
  pushZcodeAccountConfig,
  readZcodeBuiltinTable
} from '../credentials/zcode-account-config-push'
import type { ZcodeChatCredentials } from '../credentials/zcode-chat-credentials'
import { readRecord, readString } from '../catalog/zcode-model-catalog-rows'

// One naming run: a disposable zcode backend under a throwaway ZCODE_HOME, so the `session/create`
// it needs for an independent prompt never lands in the user's own conversation history. The
// account push supplies the credentials; the reply accumulates from `text_delta` events until the
// turn settles.

const NAMING_RUN_TIMEOUT_MS = 90_000

export type ZcodeNamingRunDeps = {
  resolveEnvironment: () => Promise<NodeJS.ProcessEnv>
  resolveCommandSettings?: () => StructuredAgentCommandSettings
  resolveChatCredentials: () => Promise<ZcodeChatCredentials | null>
}

export class ZcodeNamingRuns {
  private readonly inFlight = new Set<AbortController>()

  /** Orca is closing shop: cancel every naming child so none outlives the host. */
  stopAll(): void {
    for (const attempt of this.inFlight) {
      attempt.abort(new Error('naming stopped'))
    }
    this.inFlight.clear()
  }

  /** Fresh independent text task; null when credentials, the boot, or the turn failed. */
  async generate(input: {
    prompt: string
    shouldExecute?: () => boolean
    signal?: AbortSignal
  }): Promise<string | null> {
    const attempt = new AbortController()
    const abortFromSignal = (): void => attempt.abort(new Error('naming cancelled'))
    // An already-cancelled caller must not spawn anything, even before the listener lands.
    if (input.signal?.aborted) {
      return null
    }
    input.signal?.addEventListener('abort', abortFromSignal, { once: true })
    this.inFlight.add(attempt)
    let home: string | null = null
    try {
      const chatCredentials = await this.deps.resolveChatCredentials()
      if (!chatCredentials) {
        return null
      }
      if (attempt.signal.aborted || input.shouldExecute?.() === false) {
        return null
      }
      home = await mkdtemp(join(tmpdir(), 'orca-zcode-naming-'))
      return await this.run({ ...input, attempt, home, chatCredentials })
    } catch {
      return null
    } finally {
      input.signal?.removeEventListener('abort', abortFromSignal)
      this.inFlight.delete(attempt)
      if (home !== null) {
        await rm(home, { recursive: true, force: true }).catch(() => undefined)
      }
    }
  }

  constructor(private readonly deps: ZcodeNamingRunDeps) {}

  private async run(input: {
    prompt: string
    shouldExecute?: () => boolean
    attempt: AbortController
    home: string
    chatCredentials: ZcodeChatCredentials | null
  }): Promise<string | null> {
    const { attempt, home, chatCredentials } = input
    const environment = await this.deps.resolveEnvironment()
    if (attempt.signal.aborted) {
      return null
    }
    // The throwaway home keeps the naming session out of the user's history; keeping the seal
    // lets the push's stored credentials decrypt as they would in the real one.
    const launch = await zcodeHeadlessLaunch(
      { ...environment, ZCODE_HOME: home },
      { commandSettings: this.deps.resolveCommandSettings?.() }
    )
    let reply = ''
    let turnSettled: ((outcome: 'completed' | 'failed') => void) | null = null
    const turnOver = new Promise<'completed' | 'failed'>((resolve) => {
      turnSettled = resolve
    })
    const connection = await spawnZcodeAppServerConnection(
      {
        command: launch.command,
        args: launch.args,
        cwd: home,
        env: launch.env,
        // Desktop-inherited ZCODE_* keys leak through the spawn's process-env base.
        envToDelete: zcodeDesktopEnvKeys(environment, launch.env)
      },
      {
        onServerRequest: (request) => this.answerAsk(connection, request, chatCredentials),
        onNotification: (method, params) => {
          if (method !== 'session/event') {
            return
          }
          const record = readRecord(params)
          const type = readString(record?.type)
          if (type === 'model.streaming') {
            const payload = readRecord(record?.payload)
            if (readString(payload?.kind) === 'text_delta') {
              reply += readString(payload?.delta) ?? ''
            }
            return
          }
          if (type === 'turn.completed') {
            turnSettled?.('completed')
          } else if (type === 'turn.failed') {
            turnSettled?.('failed')
          }
        }
      }
    )
    try {
      const deadline = Date.now() + NAMING_RUN_TIMEOUT_MS
      const budget = (): { timeoutMs: number; onReply: () => void } => ({
        timeoutMs: Math.max(1, deadline - Date.now()),
        onReply: () => attempt.signal.throwIfAborted()
      })
      const table = readZcodeBuiltinTable(launch.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE ?? null)
      const push = await pushZcodeAccountConfig(connection, table, chatCredentials)
      if (!push.pushed) {
        return null
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: zcode app-server frames and provider responses own these payload shapes.
      const created = (await connection.request(
        'session/create',
        { workspace: { workspacePath: home, workspaceKey: home } },
        budget()
      )) as { session?: unknown } | null
      const providerSessionId = readString(readRecord(readRecord(created)?.session)?.sessionId)
      if (!providerSessionId) {
        return null
      }
      await connection.request(
        'session/subscribe',
        {
          sessionId: providerSessionId,
          deliveryKind: 'desktop-continuous',
          includeSnapshot: false,
          afterSeq: 0
        },
        budget()
      )
      attempt.signal.throwIfAborted()
      if (input.shouldExecute?.() === false) {
        return null
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: zcode app-server frames and provider responses own these payload shapes.
      const sent = (await connection.request(
        'session/send',
        { sessionId: providerSessionId, content: input.prompt },
        budget()
      )) as { accepted?: unknown } | null
      if (sent?.accepted !== true) {
        return null
      }
      // Abort ends the wait at once: the finally below closes the connection instead of leaving
      // the naming child running for the rest of its budget.
      const outcome = await Promise.race([
        turnOver,
        new Promise<'timeout'>((resolve) => {
          const timer = setTimeout(() => resolve('timeout'), Math.max(1, deadline - Date.now()))
          timer.unref()
        }),
        new Promise<'aborted'>((resolve) => {
          attempt.signal.addEventListener('abort', () => resolve('aborted'), { once: true })
        })
      ])
      attempt.signal.throwIfAborted()
      return outcome === 'completed' && reply.trim().length > 0 ? reply : null
    } finally {
      await connection.close().catch(() => undefined)
    }
  }

  /** The asks a booting backend sends before it can answer a prompt. */
  private answerAsk(
    connection: ZcodeAppServerConnection,
    request: { method: string; id: number | string },
    chatCredentials: ZcodeChatCredentials | null
  ): void {
    if (request.method === 'session/requestRuntimePreferences') {
      connection.respond(request.id, {
        nativeSearchEnhancementsEnabled: false,
        memoryEnabled: false,
        askUserQuestionAutoResolutionEnabled: false
      })
      return
    }
    if (request.method === 'interaction/requestProviderRuntimeHeaders') {
      const credentials = chatCredentials
      if (credentials) {
        connection.respond(request.id, {
          headersApplied: true,
          requestAuth: { apiKey: credentials.apiKey }
        })
      } else {
        connection.respondWithError(request.id, -32000, 'no coding plan key is available to Orca')
      }
      return
    }
    connection.respondWithError(request.id, -32601, `Orca does not answer ${request.method}`)
  }
}

import { homedir } from 'node:os'
import {
  assertStructuredAgentResolutionCurrent,
  type StructuredAgentCommandSettings,
  type StructuredAgentResolutionOperation
} from '../../../native-chat/agent-launch/structured-agent-command-resolution'
import { requireLegacyAgentSessionAccountHome } from '../../../../shared/agent-session/lifecycle/agent-session-account-home'
import { isMissingProviderExecutable } from '../../../provider-process/provider-executable-missing'
import { AGENT_MODEL_CATALOG_PROBE_TIMEOUT_MS } from '../../../native-chat/agent-model-catalog/agent-model-catalog-probe-runner'
import type {
  AgentModelCatalogLookup,
  AgentModelCatalogProbe
} from '../../../native-chat/agent-model-catalog/agent-model-catalog-discovery'
import type { AgentModelCatalogSuccess } from '../../../native-chat/agent-model-catalog/agent-model-catalog-entry'
import { AgentModelCatalogUnavailableError } from '../../../native-chat/agent-model-catalog/agent-model-catalog-unavailable'
import { spawnZcodeAppServerConnection } from '../../../zcode/app-server/zcode-app-server-connection'
import type {
  ZcodeAppServerConnection,
  ZcodeAppServerServerRequest
} from '../../../zcode/app-server/zcode-app-server-connection-types'
import { zcodeHeadlessLaunch } from '../launch/zcode-headless-launch'
import {
  pushZcodeAccountConfig,
  readZcodeBuiltinTable
} from '../credentials/zcode-account-config-push'
import type { ZcodeChatCredentials } from '../credentials/zcode-chat-credentials'
import { readRecord, readString, readZcodeCatalogModelRows } from './zcode-model-catalog-rows'

export type ZcodeModelCatalogProbeDeps = {
  resolveEnvironment: () => Promise<NodeJS.ProcessEnv>
  resolveCommandSettings?: () => StructuredAgentCommandSettings
  resolveLaunchArgs?: () => Promise<string[]> | string[]
  resolveChatCredentials: () => ZcodeChatCredentials | null
}

/** The zcode launch a catalog probe runs: the same bundled-first composition a chat session uses. */
async function zcodeCatalogLaunch(
  environment: NodeJS.ProcessEnv,
  deps: ZcodeModelCatalogProbeDeps
): Promise<{ command: string; args: string[]; env: Record<string, string> }> {
  return zcodeHeadlessLaunch(environment, {
    ...(deps.resolveCommandSettings ? { commandSettings: deps.resolveCommandSettings() } : {}),
    ...(deps.resolveLaunchArgs ? { launchArgs: await deps.resolveLaunchArgs() } : {})
  })
}

/**
 * List a zcode account's models without a chat: boot the same backend a session would run, push
 * the account snapshot, and read the fresh session's `settings.model.available` projection.
 */
export function createZcodeModelCatalogProbe(
  deps: ZcodeModelCatalogProbeDeps
): AgentModelCatalogProbe {
  const resolve = async (
    accountHome: Parameters<AgentModelCatalogProbe>[0],
    cwd?: string,
    _lookup?: AgentModelCatalogLookup,
    operation?: StructuredAgentResolutionOperation
  ) => {
    assertStructuredAgentResolutionCurrent(operation)
    const environment = await deps.resolveEnvironment()
    assertStructuredAgentResolutionCurrent(operation)
    const workspace = cwd ?? requireLegacyAgentSessionAccountHome(accountHome).path ?? homedir()
    const launch = await zcodeCatalogLaunch(environment, deps)
    return {
      identity: { command: launch.command, args: launch.args, cwd: workspace },
      run: async (
        signal?: AbortSignal,
        runOperation = operation
      ): Promise<AgentModelCatalogSuccess> => {
        assertStructuredAgentResolutionCurrent(runOperation)
        signal?.throwIfAborted()
        // Frames can arrive before the spawn promise settles, so asks route through a holder.
        let asks: ((request: ZcodeAppServerServerRequest) => void) | null = null
        let declaredModels: readonly { providerId: string; modelId: string }[] = []
        const connection = await spawnZcodeAppServerConnection(
          { command: launch.command, args: launch.args, cwd: workspace, env: launch.env },
          {
            onServerRequest: (request) => asks?.(request)
          }
        )
        asks = (request) => answerProbeAsk(connection, request, deps)
        try {
          signal?.throwIfAborted()
          // The backend accepts nothing until its storage boots, which it announces no other way
          // than accepting a session: retry the handshake inside the run's own budget instead of
          // parking the whole budget on a fixed wait (a listing must land while pickers wait).
          const deadline = Date.now() + AGENT_MODEL_CATALOG_PROBE_TIMEOUT_MS
          let subscription: { snapshot?: unknown } | null = null
          let lastError: unknown = new Error('zcode catalog probe gave up before opening a session')
          while (Date.now() < deadline) {
            signal?.throwIfAborted()
            const left = deadline - Date.now()
            const timeout = { timeoutMs: left, onReply: () => signal?.throwIfAborted() }
            try {
              const table = readZcodeBuiltinTable(
                launch.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE ?? null
              )
              const push = await pushZcodeAccountConfig(
                connection,
                table,
                deps.resolveChatCredentials()
              )
              declaredModels = push.declaredModels
              assertStructuredAgentResolutionCurrent(runOperation)
              // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: zcode app-server frames and provider responses own these payload shapes.
              const created = (await connection.request(
                'session/create',
                { workspace: { workspacePath: workspace, workspaceKey: workspace } },
                timeout
              )) as { session?: unknown } | null
              const providerSessionId = readString(
                readRecord(readRecord(created)?.session)?.sessionId
              )
              if (!providerSessionId) {
                throw new Error('zcode catalog probe opened no session')
              }
              // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: zcode app-server frames and provider responses own these payload shapes.
              subscription = (await connection.request(
                'session/subscribe',
                {
                  sessionId: providerSessionId,
                  deliveryKind: 'desktop-continuous',
                  includeSnapshot: true,
                  afterSeq: 0
                },
                timeout
              )) as { snapshot?: unknown } | null
              break
            } catch (error) {
              lastError = error
              if (isMissingProviderExecutable(error, launch.command)) {
                throw new AgentModelCatalogUnavailableError({ reason: 'cliMissing' })
              }
              await wait(1_000, signal)
            }
          }
          if (!subscription) {
            throw lastError
          }
          assertStructuredAgentResolutionCurrent(runOperation)
          const settings = readRecord(readRecord(subscription?.snapshot)?.settings)
          const model = readRecord(settings?.model)
          // The backend's available names only the live selection; the push's declared ids are
          // the plan's real menu, and the snapshot's thought level menu covers their efforts.
          const thought = readRecord(settings?.thoughtLevel)
          const levelChoices = Array.isArray(thought?.available)
            ? thought.available.flatMap((level) => {
                const item = readRecord(level)
                const value = readString(item?.value)
                return value ? [{ value, label: readString(item?.label) ?? value }] : []
              })
            : []
          const models = readZcodeCatalogModelRows(model?.available, model?.current, {
            declaredModels,
            fallbackLevels: levelChoices
          })
          if (models.length === 0) {
            throw new AgentModelCatalogUnavailableError({ reason: 'notSignedIn' })
          }
          const current = readRecord(model?.current)
          // `settings.model.current` carries providerId/modelId directly (no `ref` wrapper).
          const currentId =
            readString(current?.providerId) && readString(current?.modelId)
              ? `${readString(current?.providerId)}/${readString(current?.modelId)}`
              : undefined
          const currentEffort = readString(readRecord(current?.options)?.reasoningLevel)
          return {
            models,
            origin: 'probe',
            complete: true,
            ...(currentId
              ? {
                  configured: {
                    model: currentId,
                    ...(currentEffort ? { effort: currentEffort } : {})
                  }
                }
              : {})
          }
        } catch (error) {
          if (isMissingProviderExecutable(error, launch.command)) {
            throw new AgentModelCatalogUnavailableError({ reason: 'cliMissing' })
          }
          throw error
        } finally {
          await connection.close().catch(() => false)
        }
      }
    }
  }
  return async (home, options) =>
    (await resolve(home, options?.cwd ?? process.cwd(), 'recover', options?.operation)).run(
      options?.signal,
      options?.operation
    )
}

/** The asks a booting backend sends before it can list anything. */
function answerProbeAsk(
  connection: ZcodeAppServerConnection,
  request: ZcodeAppServerServerRequest,
  deps: ZcodeModelCatalogProbeDeps
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
    const credentials = deps.resolveChatCredentials()
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

function wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolveWait) => {
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolveWait()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}

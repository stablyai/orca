import {
  composeStructuredLaunch,
  composeStructuredLaunchRead,
  structuredAgentLaunchSources
} from '../runtime/agent-session/launch/structured-agent-launch-composition'
import type { StructuredAgentRuntimeRegistration } from '../runtime/agent-session/installation/structured-agent-runtime-registration-types'
import { runAgentModelCatalogSession } from '../native-chat/agent-model-catalog/agent-model-catalog-probe-runner'
import { TRAEX_STRUCTURED_AGENT } from './traex-agent-definition'
import { TRAEX_RUNTIME_METADATA } from './traex-runtime-metadata'
import { resolveTraexReadLaunch, traexLaunchPart } from './traex-launch-resolution'
import { TraexSessionAdapter } from './traex-session-adapter'
import { TraexAppServerConnection } from './traex-app-server-connection'
import { readTraexTurns } from './traex-thread-history'
import { traexThreadResponseSchema } from './traex-protocol'
import { createTraexConversationHistoryImporter } from './traex-conversation-history-import'
import { createTraexAtRestCommands } from './traex-at-rest-commands'
import { createTraexTextGeneration } from './traex-text-generation'
import {
  providerTimelineTurnKeyPart,
  isProviderTimelineTurnInNamespace
} from '../native-chat/agent-session-timeline/provider-timeline-identity'
import { restoreJournal } from '../native-chat/agent-session-journal/replay/journal-open'
import { pickAgentSessionOption } from '../runtime/agent-session/records/agent-session-record-options'

export const TRAEX_RUNTIME_REGISTRATION: StructuredAgentRuntimeRegistration = Object.assign(
  TRAEX_RUNTIME_METADATA,
  {
    createAdapter: ((context) => {
      const sources = structuredAgentLaunchSources(context)
      const part = traexLaunchPart({
        resolveLaunchArgs: () => context.deps.resolveLaunchArgs('trae'),
        readJournal: (sessionId) => restoreJournal(context.journalDatabase.db, sessionId)
      })
      const readLaunch = composeStructuredLaunchRead(TRAEX_STRUCTURED_AGENT, sources, part)
      const naming = createTraexTextGeneration(context)
      return new TraexSessionAdapter({
        generateText: naming.generate,
        stopNaming: naming.stop,
        closeNaming: naming.close,
        renameAtRest: async (input) => {
          const cwd =
            input.record.launchDirectory ??
            (await context.deps.resolveWorkspacePath(input.record.location.workspaceId))
          const launch = await resolveTraexReadLaunch(context, input.record.accountHome, cwd)
          await runAgentModelCatalogSession(
            () => new TraexAppServerConnection(launch),
            async (connection) => {
              await connection.initialize()
              await connection.request('thread/name/set', {
                threadId: input.providerSessionId,
                name: input.name
              })
            },
            { label: 'trae' }
          )
        },
        atRestCommands: createTraexAtRestCommands(context),
        readConversationHistory: createTraexConversationHistoryImporter(context),
        resolveLaunch: composeStructuredLaunch(TRAEX_STRUCTURED_AGENT, sources, part),
        readProcessStartTime: context.deps.readProcessStartTime,
        logger: context.deps.logger,
        onChildWorkEvidence: (sessionId, evidence, producer) =>
          context.host()?.publishChildWorkEvidence(sessionId, evidence, producer),
        onModeChanged: async (sessionId, fence, mode) => {
          await context.store.reviseSessionOptions(pickAgentSessionOption, {
            sessionId,
            fence,
            key: 'interactionMode',
            value: mode,
            models: undefined,
            now: Date.now()
          })
        },
        onLifecycle: context.deliverLifecycle,
        onSettled: (sessionId, clientMessageId, providerIdentity) =>
          context.followUps.onDispatchSettledLate({ sessionId, clientMessageId, providerIdentity }),
        copyConversation: async (input) => {
          const launch = await readLaunch(input.identity)
          return runAgentModelCatalogSession(
            () => new TraexAppServerConnection(launch),
            async (connection) => {
              await connection.initialize()
              input.signal?.throwIfAborted()
              let lastTurnId = input.checkpoint?.turnId
              if (lastTurnId?.startsWith('p:')) {
                const part = providerTimelineTurnKeyPart(lastTurnId)
                if (
                  !part ||
                  part.includes('#') ||
                  !isProviderTimelineTurnInNamespace(lastTurnId, input.providerSessionId)
                ) {
                  throw new Error('TRAE CLI fork checkpoint could not be resolved')
                }
                lastTurnId = decodeURIComponent(part)
              }
              const response = traexThreadResponseSchema.parse(
                await connection.request('thread/fork', {
                  threadId: input.providerSessionId,
                  cwd: launch.cwd,
                  excludeTurns: true,
                  ...(lastTurnId ? { lastTurnId } : {}),
                  ...(input.title ? { name: input.title } : {})
                })
              )
              const turns = await readTraexTurns(connection, response.thread.id, () =>
                input.signal?.throwIfAborted()
              )
              return {
                sessionId: response.thread.id,
                ...(response.thread.path ? { filePath: response.thread.path } : {}),
                coverage: { unit: 'traex-turn' as const, ids: turns.map((turn) => turn.id) }
              }
            },
            { label: 'trae', signal: input.signal, timeoutMs: 30_000 }
          )
        }
      })
    }) satisfies StructuredAgentRuntimeRegistration['createAdapter']
  }
)

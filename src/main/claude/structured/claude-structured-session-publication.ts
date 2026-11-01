import { agentSessionAccountHome } from '../../../shared/agent-session-account-home'
import { CLAUDE_STRUCTURED_AGENT } from '../claude-structured-agent-definition'
import { randomUUID } from 'node:crypto'
import { refreshClaudeStructuredSessionOptions } from '../claude-structured-session-options'
import type {
  AgentSessionAcquisition,
  StructuredAgentSessionAcquireInput
} from '../../native-chat/agent-session-wire/structured-agent-session-adapter'
import { claudeProviderHandleLink } from './claude-structured-owner-identity'
import type { ClaudePromptRegistry } from '../claude-prompt-registry'
import type { ClaudeJournalTranslator } from '../claude-journal-translator-contract'
import type {
  ClaudeSession,
  ClaudeAcquisitionAttempt,
  ClaudeAcquireCallbacks,
  ClaudeStructuredSessionEvent,
  ClaudeStructuredSessionAdapterDeps
} from './claude-structured-session-state'
import { ClaudeBackgroundTaskTracker } from '../claude-background-task-tracker'
import { ClaudeChildWorkDecoder } from '../claude-child-work-decoder'
import { ClaudeSlashCommandCatalog } from '../claude-slash-command-catalog'
import type { ClaudeStructuredLaunch } from '../claude-structured-launch-resolution'
import type { ClaudeAcquisitionLaunch } from '../claude-structured-acquisition-launch'
import type { ClaudeNamingGeneration } from '../claude-naming-generation'
import { readClaudeStartupFacts } from './claude-structured-session-startup'

function claudeSessionInitialization(input: {
  launch: ClaudeStructuredLaunch
  proof: ClaudeSession['initialization']['proof']
  contextActivity: number
  onLateRefusal: ClaudeSession['initialization']['onLateRefusal']
  connection: ClaudeSession['connection']
  emit: (event: ClaudeStructuredSessionEvent) => void
  naming: ClaudeNamingGeneration | undefined
  requestTimeoutMs: number | undefined
}): ClaudeSession['initialization'] {
  const { launch, proof, contextActivity, onLateRefusal, naming, connection } = input
  const facts = naming
    ? readClaudeStartupFacts({
        connection,
        initProof: proof,
        sessionId: naming.chat,
        providerSessionId: launch.providerSessionId,
        resumesTranscript: launch.resumesTranscript,
        account: launch.account,
        emit: input.emit,
        requestTimeoutMs: input.requestTimeoutMs
      })
    : undefined
  void facts
    ?.then(
      () => naming?.initialized(),
      async (error: unknown) => {
        // Independent startup cleanup remains live after delivery stops.
        proof.reject(error instanceof Error ? error : new Error(String(error)))
        try {
          await connection.close()
        } finally {
          naming?.failed()
        }
      }
    )
    .catch(() => {})
  return {
    proof,
    ...(facts ? { facts } : {}),
    account: launch.account,
    ...(launch.accountRecipe ? { accountRecipe: launch.accountRecipe } : {}),
    resumesTranscript: launch.resumesTranscript,
    claudeConfigDir: launch.claudeConfigDir,
    cwd: launch.cwd,
    history: {
      leafUuid: launch.resumeLeafUuid,
      covered: !launch.resumesTranscript || launch.resumeLeafUuid === null,
      contextActivity
    },
    onLateRefusal
  }
}

const mintClaudeAcquisitionGeneration = (deps: ClaudeStructuredSessionAdapterDeps) =>
  deps.mintAcquisitionGeneration?.() ?? randomUUID()

export function createClaudeSessionPublication(input: {
  connection: ClaudeSession['connection']
  launch: ClaudeAcquisitionLaunch
  request: StructuredAgentSessionAcquireInput
  deps: ClaudeStructuredSessionAdapterDeps
  leafUuid: string | null
  prompts: ClaudePromptRegistry
  translator: ClaudeJournalTranslator | null
  unbindReadingControl?: () => void
  process: AgentSessionAcquisition['process']
  initialization: Omit<
    Parameters<typeof claudeSessionInitialization>[0],
    'launch' | 'connection' | 'requestTimeoutMs'
  >
}): { acquisition: AgentSessionAcquisition; session: ClaudeSession } {
  const acquisitionGeneration = mintClaudeAcquisitionGeneration(input.deps)
  const linkId = input.deps.mintLinkId?.()
  const link = claudeProviderHandleLink({
    sessionId: input.launch.providerSessionId,
    leafUuid: input.leafUuid,
    resumed: input.launch.continuesChain,
    ...(input.launch.forkedFromKey ? { forkedFromKey: input.launch.forkedFromKey } : {}),
    fence: input.request.fence,
    ...(linkId ? { linkId } : {}),
    observedAt: input.deps.now?.() ?? Date.now()
  })
  return {
    acquisition: {
      process: input.process,
      acquisitionGeneration,
      ...(input.launch.accountRecipe ? { accountRecipe: input.launch.accountRecipe } : {}),
      accountHome: agentSessionAccountHome(CLAUDE_STRUCTURED_AGENT, input.launch.claudeConfigDir)
    },
    session: {
      connection: input.connection,
      providerSessionId: input.launch.providerSessionId,
      leafUuid: input.leafUuid,
      turnEndLeafUuid: input.launch.resumeLeafUuid,
      fence: input.request.fence,
      acquisitionGeneration,
      prompts: input.prompts,
      dispatchWaiters: [],
      retiredDispatchWaiters: [],
      replayContentFallbackBlocked: false,
      backgroundTasks: new ClaudeBackgroundTaskTracker(),
      childWork: new ClaudeChildWorkDecoder(),
      // An unread catalog is unavailable, not empty.
      commands: new ClaudeSlashCommandCatalog(),
      dispatchSequence: 0,
      optionMutationSequence: 0,
      options: new Map(input.launch.savedOptions.options),
      capabilities: [],
      reportedOptions: {},
      reportedModelMutation: 0,
      confirmedOptions: new Set(),
      // Only options included at launch can skip their first control write.
      appliedInputOptions: new Map(
        [...(input.launch.savedOptions.options ?? [])].filter(
          ([key]) => key === 'model' || key === 'effort'
        )
      ),
      fastModeAtStart: false,
      translator: input.translator,
      events: input.request.events,
      ...(input.unbindReadingControl ? { unbindReadingControl: input.unbindReadingControl } : {}),
      link,
      initialization: claudeSessionInitialization({
        ...input.initialization,
        launch: input.launch,
        connection: input.connection,
        requestTimeoutMs: input.deps.requestTimeoutMs
      })
    }
  }
}

/** Optional reporting keeps the same acquisition and connection as native result publication. */
export function reportClaudeOptions(
  session: ClaudeSession,
  sessions: Map<string, ClaudeSession>,
  input: StructuredAgentSessionAcquireInput,
  timeoutMs: number | undefined,
  attempt: ClaudeAcquisitionAttempt,
  callbacks: ClaudeAcquireCallbacks
): void {
  const sessionId = input.identity.sessionId
  void refreshClaudeStructuredSessionOptions(
    session,
    timeoutMs,
    () => sessions.get(sessionId) === session,
    (options) =>
      callbacks.deliver(attempt, sessionId, () =>
        callbacks.emit(session, input.events, {
          type: 'options-reported',
          sessionId,
          fence: session.fence,
          acquisitionGeneration: session.acquisitionGeneration,
          reportedOptions: options.current
        })
      )
  ).catch(() => {})
}

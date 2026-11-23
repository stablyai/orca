import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import { ClaudeBackgroundTaskTracker } from '../../background-tasks/claude-background-task-tracker'
import { ClaudeChildWorkDecoder } from '../../child-work/claude-child-work-decoder'
import { ClaudeSlashCommandCatalog } from '../../command-catalog/claude-slash-command-catalog'
import { runClaudeControl } from '../../sdk-transport/claude-agent-sdk-control-requests'
import type { StructuredAgentSessionEventSink } from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import type { ClaudeSession } from '../claude-structured-session-state'
import { ClaudeJournalBoundDelivery } from '../journal/claude-journal-bound-delivery'
import { createClaudeJournalTranslator } from '../journal/claude-structured-journal-translation'
import { claudeProviderHandleLink } from '../lifecycle/claude-structured-owner-identity'
import {
  createClaudeInitProof,
  observeClaudeReportedPermissionMode
} from '../startup/claude-structured-init-proof'
import { openClaudeSession } from '../startup/claude-structured-session-startup'
import { createClaudeStartupOutcome } from '../startup/claude-structured-startup-outcome'
import {
  claimClaudeFullAccessRefusalNotice,
  journalClaudeSessionPermissionNotice
} from './claude-full-access-refusal-notice'
import { observeClaudeRootInit, readClaudeRootInit } from './claude-permission-startup'
import { ClaudePromptRegistry } from './claude-prompt-registry'

export function permissionTestSession(
  permissionMode: 'auto' | 'bypassPermissions',
  reply: (mode: PermissionMode) => Promise<void> = async () => {}
) {
  const writes: PermissionMode[] = []
  const rows: string[] = []
  const unused = async (): Promise<never> => {
    throw new Error('Unexpected Claude request')
  }
  const events: StructuredAgentSessionEventSink = {
    appendItem: (_identity, body) => {
      if (body.kind === 'status') {
        rows.push(body.text)
      }
    },
    appendTombstone: () => {},
    publish: () => {}
  }
  const session: ClaudeSession = {
    connection: {
      pid: undefined,
      closed: false,
      exitVerdict: { root: 'live', tree: 'live' },
      send: unused,
      close: unused,
      interrupt: unused,
      cancelAsyncMessage: unused,
      setModel: async () => {},
      setPermissionMode: (mode) => {
        writes.push(mode)
        return reply(mode)
      },
      applyFlagSettings: async () => {},
      stopTask: unused,
      backgroundTask: unused,
      supportedModels: unused,
      mcpServerStatus: unused,
      initializationResult: unused,
      getSettings: async () => ({ effective: {} }),
      getContextUsage: unused,
      renameSession: unused
    },
    providerSessionId: 'provider-session',
    leafUuid: null,
    turnEndLeafUuid: null,
    fence: 1,
    acquisitionGeneration: 'process',
    prompts: new ClaudePromptRegistry(),
    dispatchWaiters: [],
    retiredDispatchWaiters: [],
    replayContentFallbackBlocked: false,
    options: new Map(),
    reportedOptions: {},
    reportedModelMutation: 0,
    confirmedOptions: new Set(),
    appliedInputOptions: new Map(),
    launchIntent: { permissionMode, model: 'first-model' },
    fullAccessRefusalNotices: { process: 'process', count: 0 },
    fastModeAtStart: false,
    capabilities: [],
    backgroundTasks: new ClaudeBackgroundTaskTracker(),
    childWork: new ClaudeChildWorkDecoder(),
    commands: new ClaudeSlashCommandCatalog(),
    dispatchSequence: 0,
    optionMutationSequence: 0,
    translator: null,
    events,
    delivery: new ClaudeJournalBoundDelivery(events),
    link: claudeProviderHandleLink({
      sessionId: 'provider-session',
      leafUuid: null,
      resumed: true,
      fence: 1,
      observedAt: 0
    }),
    initialization: {
      proof: createClaudeInitProof(),
      account: 'system',
      resumesTranscript: true,
      claudeConfigDir: '/claude',
      cwd: '/workspace',
      history: { leafUuid: null, covered: true, contextActivity: 0 },
      onLateRefusal: () => {},
      startup: createClaudeStartupOutcome()
    }
  }
  const translator = createClaudeJournalTranslator({
    sink: events,
    delivery: session.delivery,
    fullAccessRefusalNotice: () => claimClaudeFullAccessRefusalNotice(session)
  })
  const frame = (subtype: 'init' | 'status', mode?: PermissionMode) => {
    const message = {
      type: 'system',
      subtype,
      session_id: session.providerSessionId,
      permissionMode: mode
    }
    observeClaudeReportedPermissionMode(session.reportedOptions, message)
    const rootInit = readClaudeRootInit(message)
    if (rootInit) {
      observeClaudeRootInit(session, rootInit)
    }
    translator.handle({ type: 'message', sessionId: 'session', message })
  }
  return { session, rows, writes, frame }
}

export function openPermissionTestSession(
  session: ClaudeSession,
  mode: PermissionMode,
  readSettings: () => Promise<unknown> = async () => ({ effective: {} })
) {
  return openClaudeSession({
    session,
    facts: Promise.resolve({
      init: null,
      initProof: session.initialization.proof,
      initialization: { current_permission_mode: mode },
      resumesTranscript: true,
      requestTimeoutMs: undefined
    }),
    readSettings,
    isCurrent: () => true,
    diagnose: () => {},
    onLateRefusal: () => {},
    report: () => {}
  })
}

export function finishPermissionCatchUp(session: ClaudeSession): void {
  session.initialization.startup.open()
  journalClaudeSessionPermissionNotice(session, { kind: 'thread' })
}

export function refuseClaudePermission(code: string): Promise<void> {
  return runClaudeControl(
    'set_permission_mode',
    async () => {
      throw Object.assign(new Error('Claude refused the permission write'), {
        errorClass: 'control_request_failed',
        errorCode: code
      })
    },
    null
  )
}

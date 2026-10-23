import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type {
  NotificationSettings,
  NotificationDispatchRequest
} from '../../shared/notification-settings-types'
import { LOCAL_EXECUTION_HOST_ID, isNativeLocalLocation } from '../../shared/execution-host'
import { agentHookServer } from '../agent-hooks/server'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { AgentReplySubmissions } from './agent-reply-submissions'
import { isClaudeHumanReply } from './claude-reply-origin'
import { isStructuredHumanReply } from './structured-reply-origin'

type ReplySettingsStore = {
  getSettings: () => { notifications: NotificationSettings }
  onSettingsChanged?: (listener: () => void) => () => void
}

export function createAgentReplyEligibility(
  store: ReplySettingsStore,
  runtime?: Pick<OrcaRuntimeService, 'resolveTerminalPane' | 'terminalRunFacts'>,
  platform: NodeJS.Platform = process.platform
) {
  let enabled = false
  let generation = 0
  let controller = new AbortController()
  let floorHost = getStructuredAgentSessionHost()
  let floors: ReturnType<NonNullable<typeof floorHost>['replyJournal']['cursors']> = new Map()
  const eligibleRequests = new WeakMap<NotificationDispatchRequest, () => boolean>()
  const revisions = new Map<string, number>()
  const submittedPtyIds = new Map<string, string>()
  const localPtyId = (paneKey: string): string | undefined => {
    try {
      const pane = runtime?.resolveTerminalPane(paneKey)
      return pane?.ptyId && pane.executionHostId === LOCAL_EXECUTION_HOST_ID
        ? pane.ptyId
        : undefined
    } catch {
      return undefined
    }
  }
  const tracker = new AgentReplySubmissions((paneKey) => {
    const id = localPtyId(paneKey)
    if (!id) {
      return undefined
    }
    submittedPtyIds.set(paneKey, id)
    return runtime?.terminalRunFacts?.takeSubmitAuthor(id)
  })
  const configure = (): void => {
    const settings = store.getSettings().notifications
    const next =
      platform === 'darwin' &&
      settings.enabled &&
      settings.agentTaskComplete &&
      settings.bringToFrontOnAgentTaskComplete
    if (next === enabled) {
      return
    }
    enabled = next
    generation++
    controller.abort()
    controller = new AbortController()
    tracker.clear()
    revisions.clear()
    submittedPtyIds.clear()
    runtime?.terminalRunFacts?.setSubmissionTracking(enabled)
    floorHost = getStructuredAgentSessionHost()
    floors = enabled ? (floorHost?.replyJournal.cursors() ?? new Map()) : new Map()
  }
  configure()
  const offSettings = store.onSettingsChanged?.(configure)
  const offHook = agentHookServer.subscribeEnrichedStatus((event) => {
    if (!enabled) {
      return
    }
    if (event.toolAgentId || event.isReplay) {
      return
    }
    revisions.set(event.paneKey, (revisions.get(event.paneKey) ?? 0) + 1)
    tracker.observe(event)
  })
  const offClear = agentHookServer.subscribePaneStatusClear((event) => {
    if ('paneKey' in event) {
      tracker.clear(event.paneKey)
      revisions.delete(event.paneKey)
      submittedPtyIds.delete(event.paneKey)
    }
  })
  return {
    async canBring(request: NotificationDispatchRequest): Promise<boolean> {
      eligibleRequests.delete(request)
      if (!enabled || !request.paneKey || request.executionHost) {
        return false
      }
      const paneKey = request.paneKey
      const startedGeneration = generation
      const revision = revisions.get(paneKey)
      const sameSettings = (): boolean => enabled && generation === startedGeneration
      const current = (): boolean => sameSettings() && revisions.get(paneKey) === revision
      if (request.surface === 'agent-session') {
        const origin = request.structuredOrigin
        const host = getStructuredAgentSessionHost()
        if (
          !origin ||
          origin.cause.kind !== 'completion' ||
          !isNativeLocalLocation(origin.scope) ||
          !host
        ) {
          return false
        }
        const turnId = origin.cause.requestId
        const snapshot = host.replyJournal.snapshot(origin.sessionId)
        if (
          !snapshot ||
          snapshot.cursor.epoch !== origin.journalCursor.epoch ||
          snapshot.cursor.sequence < origin.journalCursor.sequence
        ) {
          return false
        }
        const floor = host === floorHost ? floors.get(origin.sessionId) : undefined
        const filtered =
          floor && floor.epoch === snapshot.cursor.epoch
            ? {
                ...snapshot,
                submissions: snapshot.submissions.filter(
                  (submission) => (submission.submittedSequence ?? 0) > floor.sequence
                )
              }
            : snapshot
        const eligible = current() && isStructuredHumanReply(filtered, turnId)
        if (eligible) {
          eligibleRequests.set(request, () => {
            const latest =
              getStructuredAgentSessionHost() === host
                ? host.replyJournal.snapshot(origin.sessionId)
                : null
            return (
              current() &&
              latest?.cursor.epoch === snapshot.cursor.epoch &&
              isStructuredHumanReply(latest, turnId)
            )
          })
        }
        return eligible
      }
      // A late request is judged on this host's newest completed main turn, never an older one's
      // verdict; while a newer turn is still running there is none.
      const completion = tracker.completion(paneKey)
      if (!completion?.human) {
        return false
      }
      const human =
        completion.source === 'codex' ||
        (completion.transcriptPath
          ? await isClaudeHumanReply(
              completion.transcriptPath,
              completion.promptId,
              controller.signal
            )
          : false)
      const stillCurrent = () =>
        sameSettings() &&
        tracker.completion(paneKey) === completion &&
        localPtyId(paneKey) === submittedPtyIds.get(paneKey)
      const eligible = human && stillCurrent()
      if (eligible) {
        eligibleRequests.set(request, stillCurrent)
      }
      return eligible
    },
    stillEligible: (request: NotificationDispatchRequest): boolean =>
      eligibleRequests.get(request)?.() === true,
    dispose(): void {
      enabled = false
      controller.abort()
      offSettings?.()
      offHook()
      offClear()
      tracker.clear()
      revisions.clear()
      submittedPtyIds.clear()
      runtime?.terminalRunFacts?.setSubmissionTracking(false)
    }
  }
}

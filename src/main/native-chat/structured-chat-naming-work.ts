import type { AgentSessionRecord } from '../../shared/agent-session/lifecycle/agent-session-record'
import type { AutomaticChatTitle, StructuredChatNamingDeps } from './structured-chat-naming-types'
import type { AgentSessionJournal } from './agent-session-journal/journal-store'

export type NamingRequest = {
  record: AgentSessionRecord
  automatic: boolean
  firstPrompt?: string
  automaticTitle?: AutomaticChatTitle
  seedingName?: string | null
}
type NamingJob = { desired?: NamingRequest; executing?: NamingRequest; preparing: boolean }

export function namingRequestOwnsRecord(request: NamingRequest, current: AgentSessionRecord) {
  return (
    !request.automaticTitle?.pending?.ended() &&
    current.conversationNameSource !== 'user' &&
    (current.conversationName === request.record.conversationName ||
      (request.seedingName !== undefined && current.conversationName === request.seedingName)) &&
    (current.providerContextBoundary?.operationId ?? null) ===
      (request.record.providerContextBoundary?.operationId ?? null)
  )
}

export function automaticChatNamingRequest(
  deps: StructuredChatNamingDeps,
  record: AgentSessionRecord,
  firstInputSubmissionKey: string | undefined,
  applicable: (request: NamingRequest) => boolean
): NamingRequest {
  const request: NamingRequest = { record, automatic: true }
  if (
    record.conversationName === undefined &&
    !(!record.providerContextBoundary && deps.workerTaskTitle(record))
  ) {
    request.automaticTitle = deps.captureAutomaticTitle?.(record, firstInputSubmissionKey, () =>
      applicable(request)
    )
  }
  return request
}

export function createStructuredChatNamingWork(deps: {
  applicable: (request: NamingRequest) => boolean
  prepare: (request: NamingRequest) => Promise<NamingRequest | null>
  execute: (request: NamingRequest, firstPrompt: string) => Promise<void>
  changed: (record: AgentSessionRecord) => void
  warn: (sessionId: string, error: unknown) => void
}) {
  const jobs = new Map<string, NamingJob>()
  const drain = (sessionId: string, job: NamingJob) => {
    const request = job.desired
    if (!job.executing && request?.firstPrompt !== undefined) {
      const firstPrompt = request.firstPrompt
      job.desired = undefined
      job.executing = request
      void deps
        .execute(request, firstPrompt)
        .catch((error: unknown) => deps.warn(sessionId, error))
        .finally(() => {
          request.automaticTitle?.pending?.dispose()
          job.executing = undefined
          drain(sessionId, job)
          deps.changed(request.record)
        })
    }
    if (!job.preparing && !job.executing && !job.desired) {
      jobs.delete(sessionId)
    }
  }
  return {
    run(request: NamingRequest) {
      const { record, automatic } = request
      const { sessionId } = record
      const job: NamingJob = jobs.get(sessionId) ?? { preparing: false }
      const pending = job.desired ?? job.executing
      if (
        pending &&
        deps.applicable(pending) &&
        pending.record.providerContextBoundary?.operationId ===
          record.providerContextBoundary?.operationId &&
        !(automatic && !pending.automatic && pending.firstPrompt === undefined)
      ) {
        request.automaticTitle?.pending?.dispose()
        return
      }
      job.desired?.automaticTitle?.pending?.dispose()
      job.executing?.automaticTitle?.pending?.dispose()
      job.desired = request
      jobs.set(sessionId, job)
      if (!job.preparing) {
        job.preparing = true
        void (async () => {
          while (job.desired && job.desired.firstPrompt === undefined) {
            const request = job.desired
            try {
              const prepared = await deps.prepare(request)
              if (!prepared) {
                request.automaticTitle?.pending?.dispose()
              }
              if (job.desired === request) {
                job.desired = prepared ?? undefined
              }
            } catch (error) {
              request.automaticTitle?.pending?.dispose()
              if (job.desired === request) {
                job.desired = undefined
              }
              deps.warn(sessionId, error)
            }
          }
        })().finally(() => {
          job.preparing = false
          drain(sessionId, job)
          if (!jobs.has(sessionId)) {
            deps.changed(record)
          }
        })
      }
      deps.changed(record)
    },
    recheck(sessionId: string) {
      const job = jobs.get(sessionId)
      job?.desired?.automaticTitle?.pending?.recheck()
      job?.executing?.automaticTitle?.pending?.recheck()
    },
    captureSourceUnavailable(sessionId: string, journal: AgentSessionJournal) {
      const job = jobs.get(sessionId)
      const desired = job?.desired?.automaticTitle?.pending
      const executing = job?.executing?.automaticTitle?.pending
      if (!desired && !executing) {
        return undefined
      }
      return () => {
        desired?.unavailable(journal)
        executing?.unavailable(journal)
      }
    },
    activeSessionIds: () =>
      [...jobs]
        .filter(
          ([, job]) =>
            (job.desired && deps.applicable(job.desired)) ||
            (job.executing && deps.applicable(job.executing))
        )
        .map(([id]) => id)
  }
}

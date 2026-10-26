import type { AgentSessionRecord } from '../../shared/agent-session-record'

export type NamingRequest = { record: AgentSessionRecord; automatic: boolean; firstPrompt?: string }
type NamingJob = { desired?: NamingRequest; executing?: NamingRequest; preparing: boolean }

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
    run(record: AgentSessionRecord, automatic: boolean) {
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
        return
      }
      job.desired = { record, automatic }
      jobs.set(sessionId, job)
      if (!job.preparing) {
        job.preparing = true
        void (async () => {
          while (job.desired && job.desired.firstPrompt === undefined) {
            const request = job.desired
            try {
              const prepared = await deps.prepare(request)
              if (job.desired === request) {
                job.desired = prepared ?? undefined
              }
            } catch (error) {
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

import type { HarnessConversationSubagent, HarnessConversationDriverSink } from './driver'
import { asRecord, extractString } from '../ai-vault/session-scanner-values'
import { OmpRpcError, type OmpRpcConnection, type OmpRpcFrame } from './omp-rpc-connection'

/** Lifecycle ids are allocated by OMP, not the task's requested labels. */
export class OmpRpcSubagents {
  private readonly sessions = new Map<string, HarnessConversationSubagent>()

  async subscribe(
    connection: OmpRpcConnection,
    sink: HarnessConversationDriverSink
  ): Promise<void> {
    try {
      await connection.request('set_subagent_subscription', { level: 'progress' })
      const response = await connection.request('get_subagents')
      const subagents = asRecord(response.data)?.subagents
      for (const value of Array.isArray(subagents) ? subagents : []) {
        sink.setSubagents(this.update(value))
      }
    } catch (error) {
      // Older OMP versions lack this optional observability command.
      if (!(error instanceof OmpRpcError)) {
        throw error
      }
    }
  }

  consume(frame: OmpRpcFrame, sink: Pick<HarnessConversationDriverSink, 'setSubagents'>): boolean {
    if (frame.type !== 'subagent_lifecycle' && frame.type !== 'subagent_progress') {
      return false
    }
    sink.setSubagents(this.update(frame.payload))
    return true
  }

  update(value: unknown, now = Date.now()): HarnessConversationSubagent[] {
    const payload = asRecord(value)
    const progress = asRecord(payload?.progress) ?? payload
    const id = extractString(progress?.id)
    const status = progress?.status
    if (!id || !['started', 'running', 'completed', 'failed', 'aborted'].includes(String(status))) {
      return [...this.sessions.values()]
    }
    const previous = this.sessions.get(id)
    const incomingPath = extractString(payload?.sessionFile)
    if (
      previous &&
      status !== 'started' &&
      ((incomingPath && previous.transcriptPath && incomingPath !== previous.transcriptPath) ||
        (previous.state === 'idle' && status === 'running'))
    ) {
      return [...this.sessions.values()]
    }
    const running = status === 'started' || status === 'running'
    const transcriptPath =
      status === 'started' ? incomingPath : (incomingPath ?? previous?.transcriptPath)
    this.sessions.set(id, {
      id,
      state: running ? 'working' : 'idle',
      startedAt: status === 'started' ? now : (previous?.startedAt ?? now),
      agentType: extractString(payload?.agent) ?? previous?.agentType,
      description: extractString(progress?.description) ?? previous?.description ?? id,
      ...(transcriptPath ? { transcriptPath } : {}),
      runStatus: running
        ? 'running'
        : status === 'aborted'
          ? 'stopped'
          : status === 'failed'
            ? 'failed'
            : 'completed'
    })
    // Match OMP's bounded retained transcript references; active rows are never evicted.
    if (this.sessions.size > 256) {
      for (const [key, session] of this.sessions) {
        if (this.sessions.size <= 256) {
          break
        }
        if (session.state === 'idle') {
          this.sessions.delete(key)
        }
      }
    }
    return [...this.sessions.values()]
  }
}

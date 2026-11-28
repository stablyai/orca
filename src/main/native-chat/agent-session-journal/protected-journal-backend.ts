import { retainProtectedUpload } from './protected-journal-uploads'
import type { JournalSqlDatabase } from './database/journal-sql-database'
import type { ProtectedJournalCall, ProtectedJournalPolicy } from './protected-journal-wire'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import { agentSessionStoreMutationKeys } from '../../runtime/agent-session/records/agent-session-store-mutation'
import type { JournalWriterCommand } from './journal-writer-command'

export class ProtectedJournalBackend {
  private readonly sessions = new Map<
    string,
    { identity: AgentSessionJournalIdentity; token: string; epoch: string }
  >()
  constructor(
    private readonly db: JournalSqlDatabase,
    private readonly policy: ProtectedJournalPolicy
  ) {}
  async execute(call: ProtectedJournalCall): Promise<unknown> {
    if (call.op === 'upload') {
      const upload = call.upload
      const retained = await retainProtectedUpload(
        this.db.stateDirectory,
        this.policy.workspaceId,
        upload
      )
      await this.db.serialize(upload.sessionId, (writer) =>
        writer.maintain({
          kind: 'protected-upload-origin',
          sessionId: upload.sessionId,
          sourcePath: upload.sourcePath,
          name: upload.name,
          ...retained
        })
      )
      return retained
    }
    if (call.op === 'open') {
      if (
        call.identity.workspaceId !== this.policy.workspaceId ||
        call.identity.hostId !== 'local' ||
        !/^[\w-]{1,128}$/.test(call.identity.sessionId)
      ) {
        throw new Error('wrong protected journal identity')
      }
      const result = await this.db.openSession(call.identity, Date.now(), call.recover)
      this.sessions.set(call.identity.sessionId, {
        identity: call.identity,
        token: result.target.ownerToken,
        epoch: result.target.epoch
      })
      return result
    }
    const id =
      call.op === 'write'
        ? call.command.target.sessionId
        : call.op === 'epoch'
          ? call.sessionId
          : call.request.sessionId
    const session = this.sessions.get(id)
    if (!session) {
      throw new Error('unopened protected journal session')
    }
    switch (call.op) {
      case 'point':
        return this.db.readers.point(call.request)
      case 'history':
        return this.db.readers.domainHistoryFrame(call.request, call.work)
      case 'epoch':
        return this.db.sessionEpoch(id)
      case 'write': {
        const { command } = call
        if (
          command.target.epoch !== session.epoch ||
          command.target.ownerToken !== session.token ||
          command.forkInstall ||
          !allowedOperation(command)
        ) {
          throw new Error('protected write refused')
        }
        for (const effect of command.effects ?? []) {
          if (effect.kind === 'receipt' && effect.receipt.sessionId === id) {
            continue
          }
          if (effect.kind === 'claim' && effect.claim.sessionId === id) {
            continue
          }
          if (effect.kind === 'store') {
            const keys = agentSessionStoreMutationKeys(effect.mutation.input)
            if (
              keys.recordIds.length === 1 &&
              keys.recordIds[0] === id &&
              !keys.tabs &&
              !keys.allCallers
            ) {
              continue
            }
          }
          throw new Error('protected journal effect refused')
        }
        return this.db.write({
          ...command,
          savedAt: Date.now(),
          facts: command.facts && { ...command.facts, identity: session.identity }
        })
      }
    }
  }
}

function allowedOperation(command: JournalWriterCommand): boolean {
  switch (command.operation.kind) {
    case 'item':
    case 'item-claiming':
    case 'dispatch':
    case 'lifecycle':
    case 'stop':
    case 'send-admission':
    case 'automatic-submission':
    case 'submission':
    case 'handover':
    case 'accept-late':
    case 'late-dispatch':
    case 'queue-insert':
    case 'queue-update':
    case 'queue-hold':
    case 'queue-withdraw':
    case 'queue-move':
    case 'queue-steer':
    case 'queue-resume':
    case 'queue-reopen':
    case 'queue-reopen-mark':
    case 'pending-unknown':
    case 'pending-reject':
    case 'queued-reject':
    case 'hold-unsent':
    case 'stop-accept':
    case 'shutdown-cut':
    case 'command-open':
    case 'command-settle':
    case 'edit-lease':
    case 'stale-settle':
    case 'dead-generation-settle':
    case 'unheld-turns-settle':
    case 'start-failure-settle':
    case 'prompt-mutate':
      return true
    case 'context-clear':
    case 'context-rewind':
    case 'epoch-replace':
    case 'fork-install':
    case 'goal-withdraw':
    case 'open':
    case 'rewind-cut':
    case 'steps':
    case 'tombstone':
      return false
  }
}

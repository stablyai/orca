// What the session link worker answers: the synchronous store and each link transaction, run only
// in the worker thread (or in process by tests, behind the same asynchronous boundary).
import type { z } from 'zod'
import type {
  LinkAddParticipantsParams,
  LinkControlParams,
  LinkSetPolicyParams,
  SessionLink,
  SessionLinkDeliveryResolution,
  SessionLinkEvent,
  SessionLinkParticipant
} from '../../../../../shared/session-link'
import type Database from '../../../../sqlite/sync-database'
import type { CrewMessageFacts } from '../../crew/crew-mutation-notifications'
import { insertMessageInto } from '../../db/messages/message-insert'
import { getRunRaw, requireRun } from '../../db/runs/run-lookup'
import type { OrchestrationCliCommand } from '../../workers/launch/orchestration-cli-command'
import type { SessionLinkAppend } from '../session-link-message-store'
import { SessionLinkStore } from '../session-link-store'
import { appendSessionLinkIntroductions } from '../session-link-message'
import { addSessionLinkParticipants } from '../session-link-group'
import { writeSessionLinkControl, writeSessionLinkPolicy } from '../session-link-owner-control'
import { resolveUnknownSessionLinkDelivery } from '../session-link-resolution'
import {
  isSessionLinkOp,
  type SessionLinkOp,
  type SessionLinkWorkerRequest,
  type SessionLinkWorkerResponse
} from './session-link-worker-protocol'

export type SessionLinkCreate = {
  id: string
  story: string
  participants: SessionLink['participants']
  policy?: SessionLink['policy']
  cli: OrchestrationCliCommand
}

export class SessionLinkOperations {
  constructor(private readonly store: SessionLinkStore) {}

  get(id: string): SessionLink {
    return this.store.get(id)
  }

  forSession(sessionId: string): SessionLink | null {
    return this.store.forSession(sessionId)
  }

  list(): SessionLink[] {
    return this.store.list()
  }

  pending(sessionId?: string): SessionLink[] {
    return this.store.pending(sessionId)
  }

  events(id: string): SessionLinkEvent[] {
    return this.store.events(id)
  }

  event(id: string): SessionLinkEvent | null {
    return this.store.event(id)
  }

  write(event: SessionLinkEvent): void {
    this.store.write(event)
  }

  pause(id: string, reason: string): void {
    this.store.pause(id, reason)
  }

  reserve(id: string, eventId: string): SessionLinkEvent | null {
    return this.store.reserve(id, eventId)
  }

  create(input: SessionLinkCreate): void {
    this.store.transaction(() => {
      const link = this.store.create(input.id, input.story, input.participants, input.policy)
      appendSessionLinkIntroductions(this.store, link, 'introduction', input.cli)
    })
  }

  /** One message per recipient, all or none. */
  send(appends: SessionLinkAppend[]): void {
    this.store.transaction(() => {
      for (const append of appends) {
        this.store.append(append)
      }
    })
  }

  control(actor: string, params: z.infer<typeof LinkControlParams>): void {
    writeSessionLinkControl(this.store, actor, params)
  }

  setPolicy(params: z.infer<typeof LinkSetPolicyParams>): void {
    writeSessionLinkPolicy(this.store, params)
  }

  addParticipants(
    params: z.infer<typeof LinkAddParticipantsParams>,
    candidates: SessionLinkParticipant[],
    cli: OrchestrationCliCommand
  ): SessionLink {
    return addSessionLinkParticipants(this.store, params, candidates, cli)
  }

  resolve(params: SessionLinkDeliveryResolution): void {
    resolveUnknownSessionLinkDelivery(this.store, params)
  }
}

function callSessionLinkOp(
  operations: SessionLinkOperations,
  op: SessionLinkOp,
  args: readonly unknown[]
): unknown {
  const method: (...args: never[]) => unknown = operations[op]
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the args crossed the worker boundary from a SessionLinks call of this same op.
  return method.apply(operations, args as never[])
}

/** The store on one connection to the orchestration file, answering one request at a time. */
export class SessionLinkConnection {
  private readonly operations: SessionLinkOperations
  private mail: CrewMessageFacts[] = []

  constructor(db: Database.Database) {
    const runs = { db, getRunRaw, requireRun }
    this.operations = new SessionLinkOperations(
      new SessionLinkStore({
        db,
        // Link messages are also inspect-only mail, written in the link's own transaction.
        insertMessage: (message) => {
          const row = insertMessageInto(runs, message)
          const { type, delivery_contract, from_handle, to_handle } = row
          this.mail.push({ type, delivery_contract, from_handle, to_handle })
          return row
        }
      })
    )
  }

  /** A refusal keeps the store's own message; mail from a rolled-back call is not reported. */
  answer(request: SessionLinkWorkerRequest): SessionLinkWorkerResponse {
    this.mail = []
    try {
      if (!isSessionLinkOp(request.op)) {
        throw new Error(`The session link worker has no ${String(request.op)} call.`)
      }
      const value = callSessionLinkOp(this.operations, request.op, request.args)
      return { id: request.id, ok: true, value, mail: this.mail }
    } catch (error) {
      return {
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }
}

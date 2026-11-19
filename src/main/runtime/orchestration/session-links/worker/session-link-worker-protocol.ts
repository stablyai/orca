// Electron-free: shared by the session link worker and its client. Each op is one store call or one
// transaction in the worker.
import type { CrewMessageFacts } from '../../crew/crew-mutation-notifications'
import type { SessionLinkOperations } from './session-link-operations'

export const SESSION_LINK_OPS = [
  'get',
  'forSession',
  'list',
  'pending',
  'events',
  'event',
  'write',
  'pause',
  'reserve',
  'create',
  'send',
  'control',
  'setPolicy',
  'addParticipants',
  'resolve'
] as const satisfies readonly (keyof SessionLinkOperations)[]

export type SessionLinkOp = (typeof SESSION_LINK_OPS)[number]

/** The store as the event loop reaches it: every call answered by the worker. */
export type SessionLinks = {
  [K in SessionLinkOp]: SessionLinkOperations[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<R>
    : never
}

export function isSessionLinkOp(op: string): op is SessionLinkOp {
  return SESSION_LINK_OPS.some((entry) => entry === op)
}

export type SessionLinkWorkerRequest = {
  id: number
  /** The orchestration database file the worker opens beside the runtime's own connection. */
  path: string
  op: SessionLinkOp
  args: unknown[]
}

export type SessionLinkWorkerResponse =
  /** `mail`: the inspect-only mail the call committed, which the runtime tells Crew about. */
  | { id: number; ok: true; value: unknown; mail: CrewMessageFacts[] }
  | { id: number; ok: false; error: string }

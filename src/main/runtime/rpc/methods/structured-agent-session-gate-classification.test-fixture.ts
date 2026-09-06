// The method-to-gate classification from `structured-agent-session-gate.ts`, as a table the
// suites iterate. Adding an `agentSession.*` method means adding it to exactly one of these.

import {
  attachParams,
  envelope,
  sendParams,
  SESSION
} from './structured-agent-session-rpc.test-fixture'
import { computeAgentSessionPayloadFingerprint } from '../../../../shared/agent-session-mutation-envelope'

/** Stops or retires work the caller already owns, so admission may already have been revoked. */
export const CLEANUP_METHODS = [
  {
    method: 'agentSession.close',
    params: { sessionId: SESSION },
    hostCall: 'close'
  },
  {
    method: 'agentSession.cancel',
    params: { envelope: envelope(), turnId: 'turn-1' },
    hostCall: 'cancel'
  },
  {
    method: 'agentSession.release',
    params: { sessionId: SESSION, holderId: 'surface-1' },
    hostCall: 'release'
  },
  {
    method: 'agentSession.unsubscribe',
    params: { sessionId: SESSION },
    hostCall: 'unsubscribe'
  }
] as const

/** Starts, extends, retains or reads work, so every one stays refused once the setting is off. */
export const ADMISSION_METHODS = [
  { method: 'agentSession.createSupport', params: { worktree: 'id:workspace-1', agent: 'codex' } },
  {
    method: 'agentSession.create',
    params: {
      envelope: envelope({
        expectedRuntimeFence: null,
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.create',
          sessionId: SESSION,
          fields: { worktree: 'id:workspace-1', agent: 'codex' }
        })
      }),
      worktree: 'id:workspace-1',
      agent: 'codex'
    }
  },
  { method: 'agentSession.ensure', params: attachParams() },
  { method: 'agentSession.send', params: sendParams() },
  {
    method: 'agentSession.respondToApproval',
    params: { envelope: envelope(), itemId: 'item-1', expectedRevision: 1, optionId: 'allow' }
  },
  {
    method: 'agentSession.respondToQuestion',
    params: { envelope: envelope(), itemId: 'item-1', expectedRevision: 1, optionId: 'yes' }
  },
  {
    method: 'agentSession.setOption',
    params: { envelope: envelope(), key: 'model', value: 'gpt-live' }
  },
  {
    method: 'agentSession.requestHandoff',
    params: { envelope: envelope(), direction: 'to-tui', mode: 'now' }
  },
  { method: 'agentSession.handoffStatus', params: { sessionId: SESSION } },
  { method: 'agentSession.options', params: { sessionId: SESSION } },
  { method: 'agentSession.history', params: { sessionId: SESSION, direction: 'tail' } },
  { method: 'agentSession.subscribe', params: { sessionId: SESSION } },
  { method: 'agentSession.hold', params: { sessionId: SESSION, holderId: 'surface-1' } },
  { method: 'agentSession.reveal', params: { sessionId: SESSION } },
  { method: 'agentSession.subscribeStatus', params: null }
] as const

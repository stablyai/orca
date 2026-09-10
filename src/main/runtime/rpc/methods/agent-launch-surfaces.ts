/**
 * How `agent.launch` builds the surface the executor decided on.
 *
 * Both halves are deliberately the plain, user-facing forms: a structured session created for the
 * worktree exactly as `agentSession.create` creates one, and a terminal agent created exactly as a
 * new agent tab is. Orchestration's own factories are NOT reusable here — a worker's session
 * carries a dispatch hold, a mailbox and a background tab that a launch the user asked for must
 * not take — which is why the executor injects this rather than branching.
 */

import { randomUUID } from 'node:crypto'
import { narrowStructuredLaunchSeedOptions } from '../../../../shared/native-chat-session-option-defaults'
import { createStructuredAgentSessionOperationId } from '../../../../shared/structured-agent-session-mutation'
import { structuredAgentSessionTabId } from '../../../../shared/structured-agent-session-projection'
import type { AgentLaunchSurfaceFactory } from '../../../agent-launch/agent-launch-executor'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import type { RpcContext } from '../core'
import { structuredCallerFor } from './structured-agent-session-gate'
import { createStructuredAgentSessionForWorktree } from './structured-agent-session-create'

export function agentLaunchSurfaceFactory(context: RpcContext): AgentLaunchSurfaceFactory {
  return {
    createStructuredSession: async ({ worktreeId, agent, options }) => {
      const sessionId = randomUUID()
      const seeded = narrowStructuredLaunchSeedOptions(options)
      const created = await createStructuredAgentSessionForWorktree({
        runtime: context.runtime,
        ensureHost: async () => {
          await context.runtime.ensureStructuredAgentSessionHost()
          return requireInstalledHost()
        },
        caller: structuredCallerFor(context),
        envelope: {
          sessionId,
          clientOperationId: createStructuredAgentSessionOperationId(randomUUID),
          expectedRuntimeFence: null,
          // Overwritten by `prepare` with the host's own attach fingerprint. The create-intent
          // conflict check it would otherwise feed guards a replayed client operation id, and this
          // id was minted here rather than accepted from one.
          payloadFingerprint: ''
        },
        worktree: `id:${worktreeId}`,
        agent,
        ...(seeded ? { options: seeded } : {}),
        // The user asked for this chat, so it takes the surface — unlike a dispatched worker.
        activate: true
      })
      if (!created.ok) {
        throw new Error(created.refusal.message)
      }
      return {
        sessionId: created.value.sessionId,
        handle: structuredAgentSessionTabId(created.value.sessionId)
      }
    },
    createTerminalAgent: async ({ worktreeId, agent }) => {
      const terminal = await context.runtime.createTerminal(`id:${worktreeId}`, {
        // The agent id is not a shell command — `cursor` is the desktop app, its CLI is
        // `cursor-agent` — so the runtime builds the configured launcher.
        startupAgent: agent
      })
      return {
        handle: terminal.handle,
        ...(terminal.warning ? { warning: terminal.warning } : {})
      }
    }
  }
}

function requireInstalledHost(): StructuredAgentSessionHost {
  const host = getStructuredAgentSessionHost()
  if (!host) {
    throw new Error('structured_agent_session_unsupported')
  }
  return host
}

/**
 * How `agent.launch` builds the surface the executor decided on.
 *
 * Both halves are deliberately the plain, user-facing forms: a structured session created for the
 * worktree exactly as `agentSession.create` creates one, and a terminal agent created exactly as a
 * new agent tab is. Orchestration's own factories are NOT reusable here — a worker's session
 * carries a dispatch hold, a mailbox and a background tab that a launch the user asked for must
 * not take — which is why the executor injects this rather than branching.
 *
 * Delivering the launch text is here for the same reason: it is the wire-shaped half. Each surface
 * takes it differently — a structured session commits it to a transcript, a terminal agent takes it
 * on its launch command or as a paste into its PTY — and which of those applies is the executor's
 * decision, carried in as `startupPrompt` or asked for through `deliverTerminalPrompt`.
 */

import { randomUUID } from 'node:crypto'
import { narrowStructuredLaunchSeedOptions } from '../../../../shared/native-chat-session-option-defaults'
import { createStructuredAgentSessionOperationId } from '../../../../shared/structured-agent-session-mutation'
import { structuredAgentSessionTabId } from '../../../../shared/structured-agent-session-projection'
import {
  AgentLaunchStructuredSessionRefusedError,
  type AgentLaunchSurfaceFactory
} from '../../../agent-launch/agent-launch-executor'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import type { RpcContext } from '../core'
import { structuredCallerFor } from './structured-agent-session-gate'
import { createStructuredAgentSessionForWorktree } from './structured-agent-session-create'
import { commitStructuredAgentSessionLaunchPrompt } from './agent-launch-structured-prompt'
import { deliverTerminalAgentLaunchPrompt } from './agent-launch-terminal-prompt'

/** Replay-safe launches keep the nested attach in the same stable caller namespace as the launch. */
export function agentLaunchSurfaceFactory(
  context: RpcContext,
  attachOperationId?: string,
  operationCallerKey?: string
): AgentLaunchSurfaceFactory {
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
        caller: operationCallerKey
          ? { callerKey: operationCallerKey }
          : structuredCallerFor(context),
        envelope: {
          sessionId,
          clientOperationId:
            attachOperationId ?? createStructuredAgentSessionOperationId(randomUUID),
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
        throw new AgentLaunchStructuredSessionRefusedError(
          created.refusal.code,
          created.refusal.message
        )
      }
      return {
        sessionId: created.value.sessionId,
        handle: structuredAgentSessionTabId(created.value.sessionId),
        fence: created.value.fence
      }
    },
    deliverStructuredPrompt: async ({ sessionId, fence, prompt }) =>
      commitStructuredAgentSessionLaunchPrompt({
        host: getStructuredAgentSessionHost(),
        caller: operationCallerKey
          ? { callerKey: operationCallerKey }
          : structuredCallerFor(context),
        sessionId,
        fence,
        text: prompt.text
      }),
    createTerminalAgent: async ({ worktreeId, agent, startupPrompt }) => {
      const terminal = await context.runtime.createTerminal(`id:${worktreeId}`, {
        // The agent id is not a shell command — `cursor` is the desktop app, its CLI is
        // `cursor-agent` — so the runtime builds the configured launcher.
        startupAgent: agent,
        // Folded into that launcher by the same startup plan a new agent tab is built from, so an
        // argv agent's prompt is in its argv at exec time rather than typed in afterwards.
        ...(startupPrompt ? { startupPrompt } : {})
      })
      return {
        handle: terminal.handle,
        ...(terminal.warning ? { warning: terminal.warning } : {})
      }
    },
    deliverTerminalPrompt: async ({ handle, prompt }) =>
      deliverTerminalAgentLaunchPrompt({
        runtime: context.runtime,
        handle,
        text: prompt.text
      })
  }
}

function requireInstalledHost(): StructuredAgentSessionHost {
  const host = getStructuredAgentSessionHost()
  if (!host) {
    throw new Error('structured_agent_session_unsupported')
  }
  return host
}

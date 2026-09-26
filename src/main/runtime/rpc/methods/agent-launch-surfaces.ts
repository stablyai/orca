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
import { tuiAgentToAgentKind } from '../../../../shared/agent-kind'
import { launchSourceSchema } from '../../../../shared/telemetry-property-schemas'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { TerminalCreateOptions } from '../../runtime-terminal-contracts'
import { narrowStructuredLaunchSeedOptions } from '../../../../shared/native-chat-session-option-defaults'
import { createStructuredAgentSessionOperationId } from '../../../../shared/structured-agent-session-mutation'
import { structuredAgentSessionTabId } from '../../../../shared/structured-agent-session-projection'
import {
  AgentLaunchStructuredSessionRefusedError,
  type AgentLaunchSurfaceFactory
} from '../../../agent-launch/agent-launch-surface-factories'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import type { RpcContext } from '../core'
import { structuredCallerFor } from './structured-agent-session-gate'
import { createStructuredAgentSessionForWorktree } from './structured-agent-session-create'
import { commitStructuredAgentSessionLaunchPrompt } from './agent-launch-structured-prompt'
import { deliverTerminalAgentLaunchPrompt } from './agent-launch-terminal-prompt'
import { AgentLaunchSessionAlreadyExistsError } from '../../../../shared/agent-launch-session-already-exists'
import { createStructuredAgentSessionId } from '../../../../shared/structured-agent-session-create'
import { toAgentLaunchPreferences } from '../../../../shared/agent-launch-preferences'
import { paneIdentity } from '../../runtime-terminal-pane-identity'

/** Replay-safe launches keep the nested attach in the same stable caller namespace as the launch. */
export function agentLaunchSurfaceFactory(
  context: RpcContext,
  attachOperationId?: string,
  operationCallerKey?: string,
  // False when the launch selects the chat for its paired caller instead of for everyone.
  activateChat = true
): AgentLaunchSurfaceFactory {
  return {
    createStructuredSession: async ({
      worktreeId,
      agent,
      options,
      sessionId: requested,
      tabId
    }) => {
      const sessionId = requested ?? createStructuredAgentSessionId(agent, randomUUID)
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
        ...(tabId ? { tabId } : {}),
        // The user asked for this chat, so it takes the surface — unlike a dispatched worker.
        activate: activateChat
      })
      if (!created.ok) {
        // The caller named this session, so a taken id is its answer, not an opaque refusal; and not
        // a definitive one, so the launch does not fall back to a terminal over it.
        if (requested && created.refusal.code === 'agent_session_conflict') {
          throw new AgentLaunchSessionAlreadyExistsError()
        }
        throw new AgentLaunchStructuredSessionRefusedError(
          created.refusal.code,
          created.refusal.message
        )
      }
      return {
        sessionId: created.value.sessionId,
        handle: structuredAgentSessionTabId(created.value.sessionId),
        fence: created.value.fence,
        ...(created.value.tabId ? { tabId: created.value.tabId } : {})
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
    createTerminalAgent: async ({
      worktreeId,
      agent,
      startupPrompt,
      agentArgs,
      cwd,
      launchSource,
      paneKey,
      options
    }) => {
      const launchPreferences = toAgentLaunchPreferences(options)
      const terminal = await context.runtime.createTerminal(`id:${worktreeId}`, {
        // The agent id is not a shell command — `cursor` is the desktop app, its CLI is
        // `cursor-agent` — so the runtime builds the configured launcher.
        startupAgent: agent,
        // Folded into that launcher by the same startup plan a new agent tab is built from, so an
        // argv agent's prompt is in its argv at exec time rather than typed in afterwards.
        ...(startupPrompt ? { startupPrompt } : {}),
        ...(agentArgs !== undefined ? { agentArgs } : {}),
        ...(cwd ? { cwd } : {}),
        // The model the user picked outranks configured args here too, as it does on a chat.
        ...(launchPreferences ? { launchPreferences } : {}),
        // A live reserved pane would be attached, not launched into, so the runtime refuses it.
        ...(paneKey ? { ...paneIdentity(paneKey), requireFreshPane: true } : {}),
        ...agentLaunchTelemetry(agent, launchSource)
      })
      return {
        handle: terminal.handle,
        // The runtime already minted this pane and baked it into the PTY's env and its own reveal;
        // dropping it here was what left a client with no way to name the tab it just asked for.
        ...(terminal.paneKey ? { paneKey: terminal.paneKey } : {}),
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

/**
 * The `agent_started` triple, of which only `launch_source` came from the caller.
 *
 * `agent_kind` and `request_kind` are derived rather than accepted — the host already knows both,
 * and a value it derives is a value a caller cannot misreport. `request_kind` is always `new`
 * because a launch reusing a terminal returns before any surface is created.
 *
 * An unrecognized `launch_source` drops the telemetry and starts the agent anyway. The wire keeps
 * the arm set open so an older host cannot refuse a newer client's launch over a label, which is
 * only honoured if the refusal does not reappear here: attribution is bookkeeping, and bookkeeping
 * must not gate the user's launch.
 */
function agentLaunchTelemetry(
  agent: TuiAgent,
  launchSource: string | undefined
): Pick<TerminalCreateOptions, 'telemetry'> {
  const parsed = launchSourceSchema.safeParse(launchSource)
  return parsed.success
    ? {
        telemetry: {
          agent_kind: tuiAgentToAgentKind(agent),
          launch_source: parsed.data,
          request_kind: 'new'
        }
      }
    : {}
}

function requireInstalledHost(): StructuredAgentSessionHost {
  const host = getStructuredAgentSessionHost()
  if (!host) {
    throw new Error('structured_agent_session_unsupported')
  }
  return host
}

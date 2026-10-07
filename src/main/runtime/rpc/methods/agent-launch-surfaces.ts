/**
 * How `agent.launch` builds the surface the executor decided on.
 *
 * Both halves are deliberately the plain, user-facing forms: a structured session created for the
 * worktree exactly as `agentSession.create` creates one, and a terminal agent created exactly as a
 * new agent tab is. Orchestration's own factories are NOT reusable here — a worker's session
 * carries a redrive subscription, a mailbox and a background tab that a launch the user asked for
 * must not take — which is why the executor injects this rather than branching.
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
import {
  trackTerminalSpawnDispatch,
  type TerminalSpawnDispatch
} from '../../../agent-launch/agent-launch-not-started'
import { AgentLaunchTabClosedError } from '../../../../shared/agent-launch-tab-closed'
import {
  agentLaunchMovesHostWindow,
  type EarlyAgentLaunchTab
} from './agent-launch-tab-publication'

/** Replay-safe launches keep the nested attach in the same stable caller namespace as the launch. */
export function agentLaunchSurfaceFactory(
  context: RpcContext,
  attachOperationId?: string,
  operationCallerKey?: string,
  // True when the launch shows its surface to the paired caller itself rather than to everyone.
  callerPresentsSurface = false,
  terminalSpawn: TerminalSpawnDispatch = trackTerminalSpawnDispatch(),
  // The tab shown before the launch ran; asked at spawn, since the window's answer and the user's
  // close can both land after admission.
  earlyTab: Pick<EarlyAgentLaunchTab, 'windowShowsTab' | 'closedByUser'> | null = null
): AgentLaunchSurfaceFactory {
  const movesHostWindow = agentLaunchMovesHostWindow(context)
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
        activate: !callerPresentsSurface
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
      options,
      viewMode
    }) => {
      const launchPreferences = toAgentLaunchPreferences(options)
      let promptRodeLaunchCommand = false
      if (earlyTab?.closedByUser()) {
        // The user closed its tab while it waited: nothing is spawned, and that is the answer.
        terminalSpawn.rethrow(new AgentLaunchTabClosedError())
      }
      const created = context.runtime.createTerminal(`id:${worktreeId}`, {
        // The agent id is not a shell command — `cursor` is the desktop app, its CLI is
        // `cursor-agent` — so the runtime builds the configured launcher.
        startupAgent: agent,
        // Offered to that launcher's startup plan; it rides only when the typed line can carry it,
        // and the runtime reports which so an uncarried prompt is pasted once the agent is ready.
        ...(startupPrompt
          ? {
              startupPrompt,
              onStartupPromptCarry: (carried: boolean) => {
                promptRodeLaunchCommand = carried
              }
            }
          : {}),
        ...(agentArgs !== undefined ? { agentArgs } : {}),
        ...(cwd ? { cwd } : {}),
        // The model the user picked outranks configured args here too, as it does on a chat.
        ...(launchPreferences ? { launchPreferences } : {}),
        // A live reserved pane would be attached, not launched into, so the runtime refuses it.
        ...(paneKey ? { ...paneIdentity(paneKey), requireFreshPane: true } : {}),
        ...(launchSource ? { launchSource } : {}),
        ...(viewMode ? { viewMode } : {}),
        ...(earlyTab?.windowShowsTab() || !movesHostWindow ? { surfaceOwner: false as const } : {}),
        onPtySpawnDispatched: terminalSpawn.onPtySpawnDispatched
      })
      const terminal = await created.catch(terminalSpawn.rethrow)
      if (earlyTab?.closedByUser()) {
        // Closed while its terminal was being created: stopped before any prompt is pasted. A prompt
        // that rode the command line reached the agent, which is stopped a moment after it starts.
        await context.runtime.closeTerminal(terminal.handle).catch(() => {})
        throw new AgentLaunchTabClosedError()
      }
      return {
        handle: terminal.handle,
        // The runtime already minted this pane and baked it into the PTY's env and its own reveal;
        // dropping it here was what left a client with no way to name the tab it just asked for.
        ...(terminal.paneKey ? { paneKey: terminal.paneKey } : {}),
        // Its only warning is that the host could not reveal the tab, which the caller shows itself.
        ...(terminal.warning && !callerPresentsSurface ? { warning: terminal.warning } : {}),
        ...(promptRodeLaunchCommand ? { promptRodeLaunchCommand } : {})
      }
    },
    deliverTerminalPrompt: async ({ handle, agent, freshLaunch, prompt }) =>
      deliverTerminalAgentLaunchPrompt({
        runtime: context.runtime,
        handle,
        agent,
        freshLaunch,
        text: prompt.text
      }),
    failedBeforeAgentStart: terminalSpawn.failedBeforeDispatch
  }
}

function requireInstalledHost(): StructuredAgentSessionHost {
  const host = getStructuredAgentSessionHost()
  if (!host) {
    throw new Error('structured_agent_session_unsupported')
  }
  return host
}

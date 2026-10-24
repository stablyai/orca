import {
  AgentLaunchFoundingIncompleteError,
  assertHostFoundingNotCancelled,
  type HostFoundingAttempt
} from '../../../agent-launch/host-founding-attempt'
import { AgentLaunchCancelledError } from '../../../../shared/agent-launch-cancellation'
import { terminalImageViewerSupported } from '../../terminal-image-viewer-env'
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
import { deriveAgentLaunchChildOperationId } from '../../../../shared/agent-launch-child-operation'
import type { AgentLaunchPromptDisposal } from '../../../../shared/agent-launch-intent'
import { narrowStructuredLaunchSeedOptions } from '../../../../shared/native-chat-session-option-defaults'
import { createStructuredAgentSessionOperationId } from '../../../../shared/structured-agent-session-mutation'
import { structuredAgentSessionTabId } from '../../../../shared/structured-agent-session-projection'
import {
  AgentLaunchStructuredSessionRefusedError,
  type AgentLaunchStructuredSurface,
  type AgentLaunchSurfaceFactory
} from '../../../agent-launch/agent-launch-surface-factories'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import type { RpcContext } from '../core'
import { STARTUP_CWD_FALLBACK_SENTENCE } from '../../../../shared/startup-cwd-fallback'
import { structuredCallerFor } from './structured-agent-session-gate'
import { createStructuredAgentSessionForWorktree } from './structured-agent-session-create'
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
  agentLaunchTabViewerRule,
  type AgentLaunchView
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
  view: AgentLaunchView = { early: null, presentation: undefined },
  attempt: HostFoundingAttempt = {}
): AgentLaunchSurfaceFactory {
  const movesHostWindow = agentLaunchMovesHostWindow(context)
  const { early: earlyTab, presentation } = view
  return {
    createStructuredSession: async ({
      worktreeId,
      agent,
      options,
      sessionId: requested,
      tabId,
      firstMessage,
      hostFoundingAttempt = {}
    }) => {
      const sessionId = requested ?? createStructuredAgentSessionId(agent, randomUUID)
      const seeded = narrowStructuredLaunchSeedOptions(options)
      const operationId = attachOperationId ?? createStructuredAgentSessionOperationId(randomUUID)
      const clientMessageId = deriveAgentLaunchChildOperationId(operationId)
      if (!clientMessageId) {
        throw new Error('agent_launch_operation_invalid')
      }
      const savedSurface = (): AgentLaunchStructuredSurface | undefined => {
        const saved = hostFoundingAttempt.adopted
        if (!saved) {
          return undefined
        }
        const opening = hostFoundingAttempt.opening
        const promptDisposal: AgentLaunchPromptDisposal =
          opening?.transaction.disposition === 'committed' && opening.row
            ? { outcome: 'journaled', messageId: opening.row.clientMessageId }
            : hostFoundingAttempt.blank?.disposition === 'committed'
              ? { outcome: 'not-delivered' }
              : { outcome: 'unconfirmed' }
        return {
          sessionId: saved.sessionId,
          handle: structuredAgentSessionTabId(saved.sessionId),
          fence: saved.fence,
          ...(saved.tabId ? { tabId: saved.tabId } : {}),
          promptDisposal
        }
      }
      let created: Awaited<ReturnType<typeof createStructuredAgentSessionForWorktree>>
      try {
        created = await createStructuredAgentSessionForWorktree({
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
            clientOperationId: operationId,
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
          ...(firstMessage ? { firstMessage: { clientMessageId, body: firstMessage } } : {}),
          hostFoundingAttempt,
          atRest: true,
          activate:
            !callerPresentsSurface &&
            (presentation === undefined || (presentation === 'focused' && movesHostWindow))
        })
      } catch (error) {
        if (error instanceof AgentLaunchCancelledError) {
          throw error
        }
        if (hostFoundingAttempt.disposition) {
          throw new AgentLaunchFoundingIncompleteError(error, savedSurface())
        }
        throw error
      }
      if (!created.ok) {
        if (hostFoundingAttempt.disposition) {
          const saved = savedSurface()
          if (
            saved &&
            hostFoundingAttempt.publication &&
            created.refusal.details?.reason !== 'tabUnconfirmed'
          ) {
            return saved
          }
          throw new AgentLaunchFoundingIncompleteError(created.refusal, saved)
        }
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
      const surface: AgentLaunchStructuredSurface = {
        sessionId: created.value.sessionId,
        handle: structuredAgentSessionTabId(created.value.sessionId),
        fence: created.value.fence,
        promptDisposal: created.value.firstMessage
          ? { outcome: 'journaled', messageId: created.value.firstMessage.clientMessageId }
          : !firstMessage
            ? { outcome: 'not-delivered' }
            : (savedSurface()?.promptDisposal ?? { outcome: 'unconfirmed' }),
        ...(created.value.tabId ? { tabId: created.value.tabId } : {})
      }
      if (hostFoundingAttempt.disposition && !hostFoundingAttempt.publication) {
        throw new AgentLaunchFoundingIncompleteError(
          new Error('created_chat_tab_not_published'),
          surface
        )
      }
      return surface
    },
    createTerminalAgent: async ({
      worktreeId,
      agent,
      startupPrompt,
      sequenceTerminalCommand,
      agentArgs,
      cwd,
      launchSource,
      paneKey,
      options,
      viewMode,
      accountEnv
    }) => {
      const launchPreferences = toAgentLaunchPreferences(options)
      let promptRodeLaunchCommand = false
      const hasEarlyTab = earlyTab !== null
      if (earlyTab?.closedByUser()) {
        // The user closed its tab while it waited: nothing is spawned, and that is the answer.
        terminalSpawn.rethrow(new AgentLaunchTabClosedError())
      }
      const created = context.runtime.createTerminal(`id:${worktreeId}`, {
        ...(attempt.cancellation ? { signal: attempt.cancellation.controller.signal } : {}),
        // The agent id is not a shell command — `cursor` is the desktop app, its CLI is
        // `cursor-agent` — so the runtime builds the configured launcher.
        startupAgent: agent,
        ...(sequenceTerminalCommand ? { sequenceTerminalCommand } : {}),
        terminalImageViewerSupported: terminalImageViewerSupported(context),
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
        ...(accountEnv ? { accountEnv: { ...accountEnv } } : {}),
        ...(presentation && (!movesHostWindow || !hasEarlyTab || presentation === 'background')
          ? { presentation: movesHostWindow ? presentation : ('background' as const) }
          : {}),
        ...(hasEarlyTab || !movesHostWindow ? { surfaceOwner: false as const } : {}),
        ...(earlyTab
          ? {
              agentLaunchViewer: () =>
                earlyTab.windowOwnsPresentation()
                  ? ('none' as const)
                  : agentLaunchTabViewerRule(context, presentation)
            }
          : {}),
        onPtySpawnDispatched: () => {
          assertHostFoundingNotCancelled(attempt)
          attempt.terminalDispatched = true
          terminalSpawn.onPtySpawnDispatched()
        }
      })
      const terminal = await created.catch(terminalSpawn.rethrow)
      attempt.terminalAdmitted = true
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
        // A caller that shows the tab itself reports a failed reveal; the fallback it can't know.
        ...launchWarning(
          terminal.startupCwdFallback ? STARTUP_CWD_FALLBACK_SENTENCE : undefined,
          callerPresentsSurface ? undefined : terminal.warning
        ),
        ...(promptRodeLaunchCommand ? { promptRodeLaunchCommand } : {})
      }
    },
    deliverTerminalPrompt: async ({ handle, agent, freshLaunch, prompt, signal }) =>
      deliverTerminalAgentLaunchPrompt({
        runtime: context.runtime,
        handle,
        agent,
        freshLaunch,
        text: prompt.text,
        ...(signal ? { signal } : {})
      })
  }
}

function launchWarning(...parts: (string | undefined)[]): { warning?: string } {
  const warning = parts.filter(Boolean).join(' ')
  return warning ? { warning } : {}
}

function requireInstalledHost(): StructuredAgentSessionHost {
  const host = getStructuredAgentSessionHost()
  if (!host) {
    throw new Error('structured_agent_session_unsupported')
  }
  return host
}

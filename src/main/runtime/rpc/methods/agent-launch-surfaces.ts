import { terminalImageViewerSupported } from '../../terminal-image-viewer-env'
/** Use ordinary user-facing terminal/chat creation; worker factories add redrive, mailbox and background-tab behavior.
 * The executor selects surface and prompt delivery; this factory supplies the wire-shaped runtime calls. */

import { randomUUID } from 'node:crypto'
import { narrowStructuredLaunchSeedOptions } from '../../../../shared/native-chat/input/native-chat-session-option-defaults'
import { createStructuredAgentSessionOperationId } from '../../../../shared/agent-session/lifecycle/structured-agent-session-mutation'
import { structuredAgentSessionTabId } from '../../../../shared/agent-session/view/structured-agent-session-projection'
import {
  AgentLaunchStructuredSessionRefusedError,
  type AgentLaunchSurfaceFactory
} from '../../../agent-launch/agent-launch-surface-factories'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import type { RpcContext } from '../core'
import { STARTUP_CWD_FALLBACK_SENTENCE } from '../../../../shared/startup-cwd-fallback'
import { structuredCallerFor } from './structured-agent-session-gate'
import { createStructuredAgentSessionForWorktree } from './structured-agent-session-create'
import { createUnderStructuredAgentSessionCloseFence } from './structured-agent-session-close-before-create'
import { structuredAgentRuntimeMetadata } from '../../structured-agent-runtime-metadata'
import { deliverTerminalAgentLaunchPrompt } from './agent-launch-terminal-prompt'
import { AgentLaunchSessionAlreadyExistsError } from '../../../../shared/agent-launch-session-already-exists'
import { AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY } from '../../../../shared/agent-session/agent-session-create-capabilities'
import { createStructuredAgentSessionId } from '../../../../shared/agent-session/structured-agent-session-create'
import { toAgentLaunchPreferences } from '../../../../shared/agent-launch-preferences'
import { paneIdentity } from '../../runtime-terminal-pane-identity'
import {
  trackTerminalSpawnDispatch,
  type TerminalSpawnDispatch
} from '../../../agent-launch/agent-launch-not-started'
import {
  AgentLaunchClosedBeforeDispatchError,
  AgentLaunchTabClosedError
} from '../../../../shared/agent-launch-tab-closed'
import { agentStartedTelemetry } from '../../../agent-launch/agent-started-telemetry'
import type { TuiAgent } from '../../../../shared/tui-agent'
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
  // Read the early pane at spawn: publication and user close can finish after admission.
  view: AgentLaunchView = { early: null, presentation: undefined }
): AgentLaunchSurfaceFactory {
  const movesHostWindow = agentLaunchMovesHostWindow(context)
  const { early: earlyTab, presentation } = view
  return {
    createStructuredSession: async ({
      worktreeId,
      agent,
      options,
      chatOptions,
      sessionId: requested,
      tabId,
      withoutPrompt,
      firstMessage,
      signal,
      closed
    }) => {
      const sessionId = requested ?? createStructuredAgentSessionId(agent, randomUUID)
      const definition = structuredAgentRuntimeMetadata(agent)?.definition
      const supported = Object.fromEntries(
        Object.entries(narrowStructuredLaunchSeedOptions(options) ?? {}).filter(([key]) =>
          definition?.restingOptions.acceptsKey(key)
        )
      )
      const seeded = chatOptions ?? (Object.keys(supported).length > 0 ? supported : undefined)
      // A client that creates chats without starting them starts this one on its first message.
      const atRest =
        firstMessage !== undefined ||
        (withoutPrompt === true &&
          context.clientCapabilities?.includes(AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY) ===
            true)
      const createArgs = {
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
          // prepare supplies the host fingerprint; this id was host-minted, so no client create-intent conflict needs checking.
          payloadFingerprint: ''
        },
        worktree: `id:${worktreeId}`,
        agent,
        ...(chatOptions?.model ? { optionsMode: 'replace-model-selection' as const } : {}),
        ...(seeded ? { options: seeded } : {}),
        ...(tabId ? { tabId } : {}),
        ...(atRest ? { atRest: true as const } : {}),
        ...(firstMessage ? { firstMessage } : {}),
        ...(signal ? { signal } : {}),
        activate:
          !callerPresentsSurface &&
          (presentation === undefined || (presentation === 'focused' && movesHostWindow))
      }
      const created = closed
        ? await createUnderLaunchCloseFence(sessionId, context.runtime, closed, createArgs)
        : await createStructuredAgentSessionForWorktree(createArgs)
      if (!created.ok) {
        // A caller-named session conflict must surface to that caller, never downgrade to terminal.
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
        ...(created.value.firstMessage ? { firstMessage: created.value.firstMessage } : {}),
        ...(created.value.tabId ? { tabId: created.value.tabId } : {})
      }
    },
    createTerminalAgent: async ({
      worktreeId,
      agent,
      startupPrompt,
      agentArgs,
      cwd,
      launchSource,
      paneKey,
      options,
      viewMode,
      accountEnv,
      startup,
      draft,
      closed
    }) => {
      const launchPreferences = toAgentLaunchPreferences(options, agent)
      let promptRodeLaunchCommand = false
      let dispatched = false
      const hasEarlyTab = earlyTab !== null
      if (earlyTab?.closedByUser()) {
        // The user closed its tab while it waited: nothing is spawned, and that is the answer.
        terminalSpawn.rethrow(new AgentLaunchTabClosedError())
      }
      if (closed?.aborted) {
        terminalSpawn.rethrow(new AgentLaunchClosedBeforeDispatchError())
      }
      const created = context.runtime.createTerminal(`id:${worktreeId}`, {
        // An agent launch the caller asked for (CLI, window or paired client) is the user's act.
        wslUserAct: true,
        ...(startup
          ? callerBuiltStartup(agent, startup, accountEnv, launchSource)
          : {
              // Let the runtime build the configured launcher: agent ids are not commands (cursor uses cursor-agent).
              startupAgent: agent,
              // The runtime reports typed-line prompt carry; paste only when the command did not carry it.
              ...(startupPrompt
                ? {
                    startupPrompt,
                    onStartupPromptCarry: (carried: boolean) => {
                      promptRodeLaunchCommand = carried
                    }
                  }
                : {}),
              ...(agentArgs !== undefined ? { agentArgs } : {}),
              // The model the user picked outranks configured args here too, as it does on a chat.
              ...(launchPreferences ? { launchPreferences } : {}),
              ...(accountEnv ? { accountEnv: { ...accountEnv } } : {})
            }),
        terminalImageViewerSupported: terminalImageViewerSupported(context),
        ...(cwd ? { cwd } : {}),
        // A live reserved pane would be attached, not launched into, so the runtime refuses it.
        ...(paneKey ? { ...paneIdentity(paneKey), requireFreshPane: true } : {}),
        ...(launchSource ? { launchSource } : {}),
        ...(viewMode ? { viewMode } : {}),
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
        // A close during account and launch preparation stops the spawn before it leaves.
        ...(closed ? { signal: closed } : {}),
        onPtySpawnDispatched: () => {
          dispatched = true
          terminalSpawn.onPtySpawnDispatched()
        }
      })
      const terminal = await created.catch((error: unknown) =>
        terminalSpawn.rethrow(
          closed?.aborted && !dispatched ? new AgentLaunchClosedBeforeDispatchError() : error
        )
      )
      if (earlyTab?.closedByUser() || closed?.aborted) {
        // Close a terminal created after its tab was closed before pasting; command-line prompts may already have reached it.
        await context.runtime.closeTerminal(terminal.handle).catch(() => {})
        throw new AgentLaunchTabClosedError()
      }
      if (draft) {
        context.runtime.pasteStartupDraftWhenReady(terminal.handle, { agent, content: draft })
      }
      return {
        handle: terminal.handle,
        terminalCreation: terminal,
        // Keep the runtime-minted paneKey so the caller can identify the tab already created.
        ...(terminal.paneKey ? { paneKey: terminal.paneKey } : {}),
        // A caller that shows the tab itself reports a failed reveal; the fallback it can't know.
        ...launchWarning(
          terminal.startupCwdFallback ? STARTUP_CWD_FALLBACK_SENTENCE : undefined,
          callerPresentsSurface ? undefined : terminal.warning
        ),
        ...(promptRodeLaunchCommand ? { promptRodeLaunchCommand } : {})
      }
    },
    deliverTerminalPrompt: async ({
      handle,
      agent,
      freshLaunch,
      terminalCreation,
      prompt,
      signal
    }) => {
      const { runtime } = context
      // A stdin-after-start prompt cannot ride a Windows launch line, so it needs the startup path's Windows proof (#10336).
      if (freshLaunch && typeof runtime.deliverStartupFollowup === 'function') {
        return runtime.deliverStartupFollowup(
          handle,
          { agent, prompt: prompt.text },
          { agentLaunch: true, terminalCreation, ...(signal ? { signal } : {}) }
        )
      }
      return deliverTerminalAgentLaunchPrompt({
        runtime,
        handle,
        agent,
        freshLaunch,
        terminalCreation,
        text: prompt.text,
        ...(signal ? { signal } : {})
      })
    }
  }
}

/** The caller quoted this command for its host; the runtime spawns it as given, attributed to `agent`.
 *  A prepared account rides over its env, as the account patch does an ordinary caller-built launch. */
function callerBuiltStartup(
  agent: TuiAgent,
  startup: NonNullable<Parameters<AgentLaunchSurfaceFactory['createTerminalAgent']>[0]['startup']>,
  accountEnv: Readonly<Record<string, string>> | undefined,
  launchSource: string | undefined
) {
  const env = startup.env || accountEnv ? { ...startup.env, ...accountEnv } : undefined
  return {
    command: startup.command,
    launchAgent: agent,
    ...(env ? { env } : {}),
    ...(startup.launchConfig ? { launchConfig: startup.launchConfig } : {}),
    ...(startup.startupCommandDelivery
      ? { startupCommandDelivery: startup.startupCommandDelivery }
      : {}),
    // Counted as the agent start it is, under the surface that asked for it.
    telemetry: agentStartedTelemetry(agent, launchSource)
  }
}

/** The same fence the RPC create runs under. A close during preparation starts nothing; one while the
 *  chat is made closes it again, and the launch answers closed, never that nothing was made. */
async function createUnderLaunchCloseFence(
  sessionId: string,
  runtime: RpcContext['runtime'],
  closed: AbortSignal,
  args: Parameters<typeof createStructuredAgentSessionForWorktree>[0]
): ReturnType<typeof createStructuredAgentSessionForWorktree> {
  const { closedFirst, result } = await createUnderStructuredAgentSessionCloseFence(
    sessionId,
    runtime,
    (capture) => createStructuredAgentSessionForWorktree({ ...args, closed, capture })
  )
  if (closedFirst) {
    throw new AgentLaunchTabClosedError()
  }
  return result
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

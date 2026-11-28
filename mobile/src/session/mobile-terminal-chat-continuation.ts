import { translate } from '../i18n/mobile-i18n'
import { triggerError } from '../platform/haptics/haptics'
import { TUI_AGENT_DISPLAY_NAMES } from '../../../src/shared/agent-launch/catalog/tui-agent-display-names'
import { CLI_CONVERSATION_ADOPTING_AGENTS } from '../../../src/shared/agent-session/view/structured-agent-cli-conversation-adoption'
import { cliChatResumeCloseFromProbe } from '../../../src/shared/agent-session/view/cli-chat-resume-close-verdict'
import { probePtyRunningWorkWithInspection } from '../../../src/shared/terminal/pty/lifecycle/pty-running-work-probe'
import type { TerminalProcessInspection } from '../../../src/shared/terminal/pty/lifecycle/terminal-process-inspection'
import { STRUCTURED_AGENT_SESSION_CLI_SOURCE_RUNTIME_CAPABILITY } from '../../../src/shared/agent-session/capabilities/structured-agent-session-surface-capabilities'
import { AGENT_SESSION_CREATE_TAB_PLACEMENT_RUNTIME_CAPABILITY } from '../../../src/shared/agent-session/lifecycle/operations/agent-session-create-capabilities'
import type { AgentSessionRefusalReference } from '../../../src/shared/agent-session/failures/agent-session-wire-refusals'
import type { TuiAgent } from '../../../src/shared/agent-launch/catalog/tui-agent'
import { mobileAgentSessionRefusalText } from './native-chat/agent-session/mobile-agent-session-refusal-text'
import {
  preflightMobileStructuredAgentResume,
  resumeMobileStructuredAgentSession
} from './native-chat/agent-session/mobile-structured-agent-session-launch'
import type { MobileTerminalChatContinuation } from './native-chat/history/mobile-terminal-chat-continuation-actions'
import {
  terminalExitWait,
  terminalProcessInspect
} from '../terminal/host-operations/mobile-terminal-operations'
import {
  launchedSelection,
  withLaunchReply,
  withoutUnansweredLaunch
} from './tabs/pending-session-selection'
import { releaseTerminalCreateLock } from '../terminal/session/creation/terminal-create-lock'
import type { MobileSessionController } from './use-mobile-session-controller'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'

type ContinuationScope = Pick<
  MobileSessionController,
  | 'client'
  | 'worktreeId'
  | 'creatingTerminalRef'
  | 'setCreating'
  | 'pendingSelectionRef'
  | 'fetchSessionTabs'
  | 'showToast'
  | 'hostCapabilities'
  | 'handleCloseSessionTab'
  | 'sessionTabsRef'
>

const PROBE_TIMEOUT_MS = 5_000
// The host's create judges writers again, so a slow exit only costs a refusal the user can retry.
const EXIT_WAIT_MS = 10_000

/** The phone's "Continue in chat" on a terminal: the same keep/close rule and host checks as the
 *  desktop's, then one chat create that takes the conversation over. Resolves once settled. */
export async function continueMobileTerminalInChat(
  scope: ContinuationScope,
  source: MobileTerminalChatContinuation
): Promise<void> {
  const agentName = TUI_AGENT_DISPLAY_NAMES[source.agent]
  const report = (message: string): void => {
    triggerError()
    scope.showToast(message, 4000)
  }
  const { client } = scope
  if (!client || scope.creatingTerminalRef.current) {
    report(copy.busy())
    return
  }
  const lock = `mobile-continue:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  scope.creatingTerminalRef.current = lock
  scope.setCreating(true)
  // Armed before anything awaits, so a tab the user picks meanwhile supersedes the chat.
  scope.pendingSelectionRef.current = launchedSelection(lock, {}, null)
  let closed = false
  let fresh = false
  try {
    const inspect = async (terminal: string): Promise<TerminalProcessInspection> => {
      const reply = await terminalProcessInspect.request(
        client,
        { terminal, scanChildProcesses: true },
        { timeoutMs: PROBE_TIMEOUT_MS }
      )
      const inspection = terminalProcessInspect.interpret(reply)
      if (!inspection) {
        throw new Error('inspection unavailable')
      }
      return inspection
    }
    // Unlike desktop, the phone has no running-process prompt to fall back on, so it acts only on
    // the host's proof of what the pane runs: an unanswered check (slow link), or work running
    // under no name, closes nothing.
    const probeClose = async () => {
      const [probe] = await probePtyRunningWorkWithInspection(
        [source.terminal],
        { timeoutMs: PROBE_TIMEOUT_MS },
        inspect
      )
      return !probe ||
        probe.verdict === 'unverifiable' ||
        (probe.verdict === 'live' && !probe.foregroundProcess)
        ? { probe, close: null }
        : { probe, close: cliChatResumeCloseFromProbe(probe, source.agent) }
    }
    const { probe, close } = await probeClose()
    if (close === null) {
      report(copy.uncheckable())
      return
    }
    if (close === 'ask') {
      report(copy.otherJob(probe?.foregroundProcess ?? agentName))
      return
    }
    const closes = close === 'close'
    const agent = await admittedChatAgent(client, scope.worktreeId, source, closes, report)
    if (!agent) {
      return
    }
    if (closes) {
      // The preflight took a round trip, so the pane may now run something else, or its agent
      // another conversation; only this conversation's agent is the user's to stop.
      const recheck = await probeClose()
      const live = scope.sessionTabsRef.current.find((tab) => tab.id === source.tab.id)
      if (
        recheck.close !== 'close' ||
        live?.type !== 'terminal' ||
        live.terminal !== source.terminal ||
        live.agentStatus?.providerSession?.id !== source.providerSessionId
      ) {
        report(copy.terminalChanged())
        return
      }
      // Asked before the close so the host is already watching when the pane goes.
      const exited = terminalExitWait
        .request(
          client,
          { terminal: source.terminal, for: 'exit', timeoutMs: EXIT_WAIT_MS },
          { timeoutMs: EXIT_WAIT_MS + 2_000 }
        )
        .catch(() => undefined)
      closed = await scope.handleCloseSessionTab(source.tab, [source.tab.id], {
        expectedTerminal: source.terminal
      })
      if (!closed) {
        return
      }
      await exited
    }
    const useCliSource =
      !closes &&
      scope.hostCapabilities?.includes(STRUCTURED_AGENT_SESSION_CLI_SOURCE_RUNTIME_CAPABILITY)
    const tabPlacement =
      source.tab.parentTabId &&
      scope.hostCapabilities?.includes(AGENT_SESSION_CREATE_TAB_PLACEMENT_RUNTIME_CAPABILITY)
        ? { afterTabId: source.tab.parentTabId }
        : undefined
    let result = await resumeMobileStructuredAgentSession(
      client,
      scope.worktreeId,
      agent,
      {
        providerSessionId: source.providerSessionId,
        ...(useCliSource
          ? { cliSource: { workspaceId: scope.worktreeId, paneKey: source.paneKey } }
          : {})
      },
      tabPlacement
    )
    // A conversation the terminal never saved has nothing to take over; as on desktop, the chat
    // starts fresh rather than leaving the user with neither.
    if (
      closed &&
      result.kind === 'failed' &&
      result.refusal?.code === 'agent_session_identity_required' &&
      result.refusal.details?.reason === 'transcriptNotFound'
    ) {
      fresh = true
      result = await resumeMobileStructuredAgentSession(
        client,
        scope.worktreeId,
        agent,
        undefined,
        tabPlacement
      )
    }
    if (result.kind === 'created') {
      scope.pendingSelectionRef.current = withLaunchReply(scope.pendingSelectionRef.current, lock, {
        sessionId: result.sessionId
      })
      void scope.fetchSessionTabs()
    } else if (result.kind === 'unknown') {
      report(copy.unconfirmed())
    } else {
      // Agent History holds the conversation only when the terminal had saved one.
      report(
        copy.failed(refusalWords(result.refusal, result.message || undefined), closed && !fresh)
      )
    }
  } catch {
    report(closed ? copy.unconfirmed() : copy.failed(copy.tryAgain(), false))
  } finally {
    scope.pendingSelectionRef.current = withoutUnansweredLaunch(
      scope.pendingSelectionRef.current,
      lock
    )
    releaseTerminalCreateLock(scope, lock)
  }
}

/** The first chat agent the host admits for this conversation, asked before the terminal closes;
 *  null once a refusal has been said. */
async function admittedChatAgent(
  client: RpcClient,
  worktreeId: string,
  source: MobileTerminalChatContinuation,
  closes: boolean,
  report: (message: string) => void
): Promise<TuiAgent | null> {
  for (const agent of CLI_CONVERSATION_ADOPTING_AGENTS[source.agent]) {
    const refusal = await preflightMobileStructuredAgentResume(client, worktreeId, agent, {
      providerSessionId: source.providerSessionId,
      // Only the pane this closes: another split running the conversation must still refuse.
      ...(closes ? { closingPaneKeys: [source.paneKey] } : {})
    })
    if (!refusal) {
      return agent
    }
    // A refusal about this conversation (another writer, another folder) holds for every agent;
    // one about this agent leaves the next to try.
    if (refusal.refusal && refusal.refusal.code !== 'structured_agent_session_unsupported') {
      report(copy.failed(refusalWords(refusal.refusal), false))
      return null
    }
    // No answer at all (a dropped link) says nothing about the agent.
    if (!refusal.refusal && !refusal.reason) {
      report(copy.failed(copy.tryAgain(), false))
      return null
    }
  }
  report(copy.unavailable(TUI_AGENT_DISPLAY_NAMES[source.agent]))
  return null
}

function refusalWords(
  refusal: AgentSessionRefusalReference | undefined,
  fallback = copy.tryAgain()
): string {
  return refusal ? mobileAgentSessionRefusalText(refusal, translate) : fallback
}

const copy = {
  busy: () =>
    translate(
      'session.terminalChatContinuation.busy',
      'Another chat or terminal is opening. Wait, then try again.'
    ),
  otherJob: (process: string) =>
    translate(
      'session.terminalChatContinuation.otherJob',
      '{{process}} is running in this terminal. Quit it, then continue in chat.',
      { process }
    ),
  unavailable: (agent: string) =>
    translate(
      'session.terminalChatContinuation.unavailable',
      "{{agent}} chats aren't available on this computer.",
      { agent }
    ),
  uncheckable: () =>
    translate(
      'session.terminalChatContinuation.uncheckable',
      "Orca couldn't check what's running in this terminal. Try again."
    ),
  terminalChanged: () =>
    translate(
      'session.terminalChatContinuation.terminalChanged',
      'This terminal changed while Orca checked it. Try again.'
    ),
  tryAgain: () => translate('session.terminalChatContinuation.tryAgain', 'Try again.'),
  failed: (detail: string, terminalClosed: boolean) =>
    terminalClosed
      ? translate(
          'session.terminalChatContinuation.failedAfterClose',
          "Couldn't continue in chat. {{detail}} The conversation is in Agent History.",
          { detail }
        )
      : translate(
          'session.terminalChatContinuation.failed',
          "Couldn't continue in chat. {{detail}}",
          {
            detail
          }
        ),
  unconfirmed: () =>
    translate(
      'session.terminalChatContinuation.unconfirmed',
      "Orca couldn't confirm the chat opened. Check your tabs before trying again."
    )
}

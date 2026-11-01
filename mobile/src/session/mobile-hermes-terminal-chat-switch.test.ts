import { beforeEach, describe, expect, it, vi } from 'vitest'

const createMobileStructuredAgentSession = vi.hoisted(() => vi.fn())

vi.mock('./mobile-structured-agent-session-launch', () => ({
  createMobileStructuredAgentSession
}))
vi.mock('../platform/haptics', () => ({
  triggerSuccess: vi.fn(),
  triggerError: vi.fn()
}))

import { STRUCTURED_AGENT_SESSION_RESUME_HISTORY_RUNTIME_CAPABILITY } from '../../../src/shared/structured-agent-session-surface-capabilities'
import { switchMobileHermesTerminalToChat } from './mobile-hermes-terminal-chat-switch'
import type { PendingSessionSelection } from './pending-session-selection'

const SESSION_ID = '11111111-1111-4111-8111-111111111111'
const TERMINAL_SESSION_ID = '20261031_144415_71256d'
const terminalTab = { id: 'tab-h' }

function harness() {
  const pendingSelectionRef: { current: PendingSessionSelection | null } = { current: null }
  const fetchSessionTabs = vi.fn(async () => {})
  const closeTerminalTab = vi.fn(async () => {})
  const showToast = vi.fn()
  return { pendingSelectionRef, fetchSessionTabs, closeTerminalTab, showToast }
}

describe('switchMobileHermesTerminalToChat', () => {
  beforeEach(() => {
    createMobileStructuredAgentSession.mockReset()
  })

  it('loads the hook session and closes the terminal only after the chat exists', async () => {
    createMobileStructuredAgentSession.mockResolvedValueOnce({
      kind: 'created',
      sessionId: 'hermes_chat_1'
    })
    const scope = harness()
    await switchMobileHermesTerminalToChat({
      client: {} as never,
      worktreeId: 'workspace-1',
      hostCapabilities: [STRUCTURED_AGENT_SESSION_RESUME_HISTORY_RUNTIME_CAPABILITY],
      providerSessionId: SESSION_ID,
      terminalTab,
      ...scope
    })
    expect(createMobileStructuredAgentSession).toHaveBeenCalledWith({}, 'workspace-1', 'hermes', {
      resumeFrom: { providerSessionId: SESSION_ID }
    })
    expect(scope.closeTerminalTab).toHaveBeenCalledWith(terminalTab)
    expect(scope.pendingSelectionRef.current).toMatchObject({
      kind: 'launched',
      surface: { sessionId: 'hermes_chat_1' }
    })
    expect(scope.fetchSessionTabs).toHaveBeenCalledTimes(1)
    expect(scope.fetchSessionTabs.mock.invocationCallOrder[0]).toBeLessThan(
      scope.closeTerminalTab.mock.invocationCallOrder[0] ?? 0
    )
  })

  it('opens a new chat and keeps the terminal when the resumed create is refused', async () => {
    createMobileStructuredAgentSession
      .mockResolvedValueOnce({ kind: 'failed', message: 'unsupported' })
      .mockResolvedValueOnce({ kind: 'created', sessionId: 'hermes_chat_2' })
    const scope = harness()
    await switchMobileHermesTerminalToChat({
      client: {} as never,
      worktreeId: 'workspace-1',
      hostCapabilities: [STRUCTURED_AGENT_SESSION_RESUME_HISTORY_RUNTIME_CAPABILITY],
      providerSessionId: SESSION_ID,
      terminalTab,
      ...scope
    })
    expect(createMobileStructuredAgentSession).toHaveBeenNthCalledWith(
      2,
      {},
      'workspace-1',
      'hermes',
      undefined
    )
    expect(scope.closeTerminalTab).not.toHaveBeenCalled()
  })

  it('does not open a second chat when the resumed create is unconfirmed', async () => {
    createMobileStructuredAgentSession.mockResolvedValueOnce({
      kind: 'unknown',
      message: 'The Hermes chat result could not be confirmed.'
    })
    const scope = harness()
    await switchMobileHermesTerminalToChat({
      client: {} as never,
      worktreeId: 'workspace-1',
      hostCapabilities: [STRUCTURED_AGENT_SESSION_RESUME_HISTORY_RUNTIME_CAPABILITY],
      providerSessionId: SESSION_ID,
      terminalTab,
      ...scope
    })
    expect(createMobileStructuredAgentSession).toHaveBeenCalledTimes(1)
    expect(scope.closeTerminalTab).not.toHaveBeenCalled()
    expect(scope.showToast).toHaveBeenCalled()
  })

  it('starts a new chat and keeps the terminal when the hook id is a TUI timestamp', async () => {
    createMobileStructuredAgentSession.mockResolvedValueOnce({
      kind: 'created',
      sessionId: 'hermes_chat_4'
    })
    const scope = harness()
    await switchMobileHermesTerminalToChat({
      client: {} as never,
      worktreeId: 'workspace-1',
      hostCapabilities: [STRUCTURED_AGENT_SESSION_RESUME_HISTORY_RUNTIME_CAPABILITY],
      providerSessionId: TERMINAL_SESSION_ID,
      terminalTab,
      ...scope
    })
    expect(createMobileStructuredAgentSession).toHaveBeenCalledWith(
      {},
      'workspace-1',
      'hermes',
      undefined
    )
    expect(scope.closeTerminalTab).not.toHaveBeenCalled()
  })

  it('starts a new chat without resume when the session id is missing', async () => {
    createMobileStructuredAgentSession.mockResolvedValueOnce({
      kind: 'created',
      sessionId: 'hermes_chat_3'
    })
    const scope = harness()
    await switchMobileHermesTerminalToChat({
      client: {} as never,
      worktreeId: 'workspace-1',
      hostCapabilities: [STRUCTURED_AGENT_SESSION_RESUME_HISTORY_RUNTIME_CAPABILITY],
      providerSessionId: null,
      terminalTab,
      ...scope
    })
    expect(createMobileStructuredAgentSession).toHaveBeenCalledWith(
      {},
      'workspace-1',
      'hermes',
      undefined
    )
    expect(scope.closeTerminalTab).not.toHaveBeenCalled()
  })
})

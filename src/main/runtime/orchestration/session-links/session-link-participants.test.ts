import { afterEach, expect, it, vi } from 'vitest'
import { sessionLinkCandidates } from './session-link-participants'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import {
  attach,
  hostTestState
} from '../../../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-harness'
import { HOST_TEST_SESSION as SESSION } from '../../../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data'
import { OrcaRuntimeService } from '../../orca-runtime'

vi.mock('../../../native-chat/agent-session-wire/host/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: vi.fn()
}))
afterEach(() => vi.restoreAllMocks())

it('offers registered agents through mail reach, excluding unavailable or closed chats', async () => {
  const { host } = hostTestState()
  await attach()
  await host.deps.store.setSessionTabVisibility(SESSION, true, 'tab-gemini')
  await host.deps.store.pinLaunchDirectory(SESSION, '/projects/acme/app')
  const record = host.deps.store.getConversation(SESSION)!
  const gemini = { ...record, provider: 'gemini' }
  vi.spyOn(host.deps.store, 'listConversations').mockReturnValue([gemini])
  vi.spyOn(host.deps.store, 'getConversation').mockImplementation((id) =>
    id === SESSION ? gemini : null
  )
  const registered = host.deps.agents.registration('codex')!
  const registration = vi
    .spyOn(host.deps.agents, 'registration')
    .mockReturnValue({ ...registered, definition: { ...registered.definition, agent: 'gemini' } })
  vi.mocked(getStructuredAgentSessionHost).mockReturnValue(host)
  const runtime = new OrcaRuntimeService()
  vi.spyOn(runtime, 'ensureStructuredAgentSessionHost').mockResolvedValue(undefined)
  vi.spyOn(runtime, 'getWorktreePs').mockResolvedValue({
    worktrees: [],
    totalCount: 0,
    truncated: false
  })
  expect(await sessionLinkCandidates(runtime)).toMatchObject([
    { sessionId: SESSION, agent: 'gemini', directory: '/projects/acme/app' }
  ])
  gemini.provider = 'antigravity'
  registration.mockReturnValue({
    ...registered,
    definition: { ...registered.definition, agent: 'antigravity' }
  })
  expect(await sessionLinkCandidates(runtime)).toMatchObject([
    { sessionId: SESSION, agent: 'antigravity', directory: '/projects/acme/app' }
  ])
  registration.mockReturnValue(null)
  expect(await sessionLinkCandidates(runtime)).toEqual([])
  registration.mockReturnValue(registered)
  await host.deps.store.setSessionTabVisibility(SESSION, false, 'tab-gemini')
  expect(await sessionLinkCandidates(runtime)).toEqual([])
})

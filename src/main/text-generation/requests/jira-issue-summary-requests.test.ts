import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getStatus } from '../../jira/client'
import {
  cancelJiraIssueSummaryRequest,
  generateJiraIssueSummaryRequest
} from './jira-issue-summary-requests'

vi.mock('../../jira/client', () => ({ getStatus: vi.fn() }))
vi.mock('../commit-message-text-generation', () => ({
  resolveCommitMessageSettings: () => ({
    ok: true,
    params: { agentId: 'custom', model: '', customAgentCommand: 'agent' }
  })
}))
vi.mock('../execution/commit-message-agent-environment', () => ({
  prepareLocalCommitMessageAgentEnv: async () => ({ ok: true })
}))
vi.mock('./jira-issue-summary-text-generation', () => ({
  cancelGenerateJiraIssueSummaryLocal: () => {},
  generateJiraIssueSummaryFromContext: async () => {
    throw new Error('Generation started after cancellation')
  }
}))

const args = { siteId: 'site-1', draftId: 'draft-1', requestId: 'request-1', description: 'A bug' }
const host = { getSettings: () => ({}), getAgentEnvironment: () => undefined }
const connected: Awaited<ReturnType<typeof getStatus>> = {
  connected: true,
  viewer: null,
  sites: [
    {
      id: 'site-1',
      siteUrl: 'https://jira.example.com',
      email: 'ada@example.com',
      displayName: 'Ada',
      accountId: 'ada',
      authType: 'server'
    }
  ]
}

beforeEach(() => vi.mocked(getStatus).mockReset().mockResolvedValue(connected))
afterEach(() => cancelJiraIssueSummaryRequest('owner', args))

it.each(['initial', 'final'] as const)(
  'honors cancellation during the %s status read',
  async (phase) => {
    const entered = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<Awaited<ReturnType<typeof getStatus>>>()
    if (phase === 'final') {
      vi.mocked(getStatus).mockResolvedValueOnce(connected)
    }
    vi.mocked(getStatus).mockImplementationOnce(() => {
      entered.resolve()
      return resume.promise
    })
    const controller = new AbortController()
    const generating = generateJiraIssueSummaryRequest(host, 'owner', args, controller.signal)
    await entered.promise
    if (phase === 'initial') {
      cancelJiraIssueSummaryRequest('owner', args)
    } else {
      controller.abort()
    }
    resume.resolve(connected)
    await expect(generating).resolves.toMatchObject({ success: false, canceled: true })
  }
)

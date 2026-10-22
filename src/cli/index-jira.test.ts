import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  callMock: vi.fn(),
  runtimeClientConstructorMock: vi.fn(),
  serveOrcaAppMock: vi.fn(),
  getDefaultUserDataPathMock: vi.fn(() => '/tmp/orca-user-data'),
  addEnvironmentFromPairingCodeMock: vi.fn(),
  listEnvironmentsMock: vi.fn(),
  spawnMock: vi.fn()
}))
vi.mock('./runtime-client', async () => {
  const { createRuntimeClientModuleMock } = await import('./index-test-harness.js')
  return createRuntimeClientModuleMock(mocks)
})
vi.mock('./runtime/environments', () => ({
  addEnvironmentFromPairingCode: mocks.addEnvironmentFromPairingCodeMock,
  listEnvironments: mocks.listEnvironmentsMock,
  removeEnvironment: vi.fn(),
  resolveEnvironment: vi.fn()
}))
vi.mock('child_process', async () => {
  const { createChildProcessModuleMock } = await import('./index-test-harness.js')
  return createChildProcessModuleMock(mocks.spawnMock)
})

import { main } from './index'
import { okFixture } from './test-fixtures'
import { pairRuntimeEnvironment, useWorktreeAwarenessEnvironment } from './index-test-harness'
import { JIRA_AGENT_ACCESS_RUNTIME_CAPABILITY } from '../shared/jira-agent-capability'
import { RuntimeClientError } from './runtime/types'

const site = {
  id: 'site-1',
  siteUrl: 'https://example.atlassian.net',
  email: 'test@example.com',
  displayName: 'Jira',
  accountId: 'user-1'
}
const issue = {
  id: '1001',
  key: 'ENG-123',
  siteId: site.id,
  title: 'Fix login',
  url: `${site.siteUrl}/browse/ENG-123`,
  project: { id: '100', key: 'ENG', name: 'Engineering' },
  issueType: { id: '10001', name: 'Bug' },
  status: { id: '1', name: 'Open', categoryName: 'To Do', categoryKey: 'new' },
  labels: ['existing'],
  updatedAt: '2026-10-13',
  createdAt: '2026-10-12'
}
const transition = {
  id: '31',
  name: 'Start progress',
  to: { ...issue.status, name: 'In Progress' }
}

function responses(overrides: Record<string, unknown> = {}): void {
  const values: Record<string, unknown> = {
    'status.get': { capabilities: [JIRA_AGENT_ACCESS_RUNTIME_CAPABILITY] },
    'jira.status': { connected: true, viewer: null, sites: [site], selectedSiteId: site.id },
    'jira.getIssue': issue,
    'jira.listIssues': [],
    'jira.searchIssues': [],
    'jira.issueComments': [],
    'jira.listProjects': [issue.project],
    'jira.listIssueTypes': [issue.issueType],
    'jira.listCreateFields': [],
    'jira.listTransitions': [transition],
    'jira.listPriorities': [],
    'jira.listAssignableUsers': [],
    'jira.createIssue': {
      ok: true,
      id: '1002',
      key: 'ENG-124',
      url: `${site.siteUrl}/browse/ENG-124`
    },
    'jira.updateIssue': { ok: true },
    'jira.addIssueComment': { ok: true, id: 'comment-1' },
    ...overrides
  }
  mocks.callMock.mockImplementation(async (method: string) => {
    if (!(method in values)) {
      throw new Error(`Unexpected RPC: ${method}`)
    }
    return okFixture('req-jira', values[method])
  })
}

async function run(args: string[], overrides: Record<string, unknown> = {}): Promise<void> {
  responses(overrides)
  await main(['jira', ...args, '--json'], '/tmp/workspace')
}

function output() {
  const calls = vi.mocked(console.log).mock.calls
  return JSON.parse(String(calls.at(-1)?.[0]))
}

function errorOutput() {
  const calls = vi.mocked(console.log).mock.calls
  return JSON.parse(String(calls.at(-1)?.[0]))
}

describe('Jira CLI', () => {
  useWorktreeAwarenessEnvironment(mocks)
  beforeEach(() => {
    process.exitCode = undefined
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    pairRuntimeEnvironment(mocks.listEnvironmentsMock, 'remote')
  })

  it('reads a URL on its exact saved site through a selected remote host', async () => {
    await run(['issue', `${site.siteUrl}/browse/eng-123`, '--environment', 'remote'], {
      'jira.status': { sites: [site, { ...site, id: 'other', siteUrl: 'https://other.example' }] }
    })
    expect(mocks.runtimeClientConstructorMock).toHaveBeenCalledWith(undefined, 'remote')
    expect(mocks.callMock).toHaveBeenCalledWith('jira.getIssue', {
      key: 'ENG-123',
      siteId: site.id,
      strict: true
    })
    expect(output()).toMatchObject({ ok: true, result: issue })
  })

  it('reports saved connections without claiming verified authentication', async () => {
    responses()
    await main(['jira', 'connection'], '/tmp/workspace')
    expect(mocks.callMock).toHaveBeenCalledTimes(1)
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('does not verify access'))
  })

  it('rejects old hosts before any Jira read or write', async () => {
    await run(['comment', 'add', 'ENG-123', '--body', 'Ready'], {
      'status.get': { capabilities: [] }
    })
    expect(errorOutput()).toMatchObject({ error: { code: 'incompatible_runtime' } })
    expect(mocks.callMock).toHaveBeenCalledTimes(1)
  })

  it('refuses ambiguous keys even when activeSiteId happens to name the first site', async () => {
    await run(['label', 'set', 'ENG-123', '--label', 'bug'], {
      'jira.status': {
        sites: [site, { ...site, id: 'other' }],
        selectedSiteId: 'all',
        activeSiteId: site.id
      }
    })
    expect(errorOutput()).toMatchObject({ error: { code: 'invalid_argument' } })
    expect(mocks.callMock).not.toHaveBeenCalledWith('jira.updateIssue', expect.anything())
  })

  it('honors explicit site selection without changing saved settings', async () => {
    await run(['issue', 'eng-123', '--site', site.id], {
      'jira.status': { sites: [site, { ...site, id: 'other' }], selectedSiteId: 'all' }
    })
    expect(mocks.callMock).toHaveBeenCalledWith('jira.getIssue', {
      key: 'ENG-123',
      siteId: site.id,
      strict: true
    })
    expect(mocks.callMock).not.toHaveBeenCalledWith('jira.selectSite', expect.anything())
  })

  it.each([
    'https://example.atlassian.net.evil.example/browse/ENG-123',
    'https://example.atlassian.net/jira/browse/ENG-123'
  ])('rejects a different origin or context path: %s', async (input) => {
    await run(['issue', input])
    expect(errorOutput()).toMatchObject({ error: { code: 'invalid_argument' } })
    expect(mocks.callMock).not.toHaveBeenCalledWith('jira.getIssue', expect.anything())
  })

  it('rejects a conflicting URL and --site', async () => {
    await run(['issue', `${site.siteUrl}/browse/ENG-123`, '--site', 'other'], {
      'jira.status': { sites: [site, { ...site, id: 'other', siteUrl: 'https://other.example' }] }
    })
    expect(errorOutput()).toMatchObject({ error: { code: 'invalid_argument' } })
  })

  it.each(['not-a-key', 'https://example.atlassian.net/projects/ENG'])(
    'rejects malformed issue targets before network access: %s',
    async (key) => {
      await run(['issue', key])
      expect(mocks.callMock).not.toHaveBeenCalled()
      expect(errorOutput()).toMatchObject({ error: { code: 'invalid_argument' } })
    }
  )

  it.each([null, { ...issue, siteId: 'other' }, { ...issue, key: 'ENG-99' }])(
    'does not claim a missing or wrong issue was read',
    async (result) => {
      await run(['issue', 'ENG-123'], { 'jira.getIssue': result })
      expect(errorOutput()).toMatchObject({ error: { code: 'jira_issue_unavailable' } })
    }
  )

  it('preserves successful empty comment results', async () => {
    await run(['comment', 'list', 'ENG-123'])
    expect(output()).toMatchObject({ ok: true, result: [] })
    expect(console.error).not.toHaveBeenCalled()
  })

  it('reads built-in filters and custom JQL on one site', async () => {
    await run(['list', '--filter', 'all', '--limit', '8'])
    expect(mocks.callMock).toHaveBeenCalledWith('jira.listIssues', {
      filter: 'all',
      limit: 8,
      siteId: site.id,
      strict: true
    })
    await run(['search', 'project = ENG AND updated >= -30d', '--limit', '5'])
    expect(mocks.callMock).toHaveBeenCalledWith('jira.searchIssues', {
      jql: 'project = ENG AND updated >= -30d',
      limit: 5,
      siteId: site.id,
      strict: true
    })
  })

  it.each([
    ['list', '--filter', 'bad'],
    ['list', '--limit', '0'],
    ['search', ' ']
  ])('rejects invalid searches before access: %s', async (...args) => {
    await run(args)
    expect(mocks.callMock).not.toHaveBeenCalled()
  })

  it('resolves a project key to its ID and preserves required custom create fields', async () => {
    await run([
      'create',
      '--project',
      'eng',
      '--type',
      '10001',
      '--title',
      'Fix login',
      '--body',
      'Details\nnext line',
      '--fields-json',
      '{"reporter":"user-9","customfield_1":{"id":"option-1"}}',
      '--user-field',
      'reporter'
    ])
    expect(mocks.callMock).toHaveBeenCalledWith('jira.createIssue', {
      siteId: site.id,
      projectId: '100',
      issueTypeId: '10001',
      title: 'Fix login',
      description: 'Details\nnext line',
      customFields: { reporter: 'user-9', customfield_1: { id: 'option-1' } },
      userFieldKeys: ['reporter']
    })
    expect(output()).toMatchObject({ ok: true, result: { key: 'ENG-124' } })
  })

  it.each(['[]', '{bad}', '{"project":{"id":"other"}}'])(
    'rejects invalid or conflicting custom fields before writes: %s',
    async (fields) => {
      await run([
        'create',
        '--project',
        'ENG',
        '--type',
        '10001',
        '--title',
        'Fix',
        '--fields-json',
        fields
      ])
      expect(mocks.callMock).not.toHaveBeenCalled()
    }
  )

  it('rejects unknown projects without creating an issue', async () => {
    await run(['create', '--project', 'UNKNOWN', '--type', '10001', '--title', 'Fix'])
    expect(mocks.callMock).not.toHaveBeenCalledWith('jira.createIssue', expect.anything())
  })

  it('writes comments and returns their ID', async () => {
    await run(['comment', 'add', 'ENG-123', '--body', 'Ready\nhttps://example.com/review/123'])
    expect(mocks.callMock).toHaveBeenCalledWith('jira.addIssueComment', {
      key: issue.key,
      siteId: site.id,
      body: 'Ready\nhttps://example.com/review/123'
    })
    expect(output()).toMatchObject({ result: { ok: true, id: 'comment-1' } })
  })

  it.each([
    ['--body', ' '],
    ['--body', 'a', '--body-file', 'b']
  ])('refuses unsafe comment input before access: %s', async (...flags) => {
    await run(['comment', 'add', 'ENG-123', ...flags])
    expect(mocks.callMock).not.toHaveBeenCalled()
  })

  it.each([[], ['--to', 'In Progress', '--to-id', '31'], ['--to', ' '], ['--to-id', ' ']])(
    'requires exactly one nonblank transition selector before access: %s',
    async (...flags) => {
      await run(['status', 'set', 'ENG-123', ...flags])
      expect(errorOutput()).toMatchObject({
        error: {
          code: 'invalid_argument',
          message: 'Pass exactly one of --to <name> or --to-id <transitionId>.'
        }
      })
      expect(mocks.callMock).not.toHaveBeenCalled()
    }
  )

  it('resolves status names using transitions of this exact issue and site', async () => {
    await run(['status', 'set', 'eng-123', '--to', 'In Progress'])
    expect(mocks.callMock).toHaveBeenCalledWith('jira.listTransitions', {
      key: issue.key,
      siteId: site.id,
      strict: true
    })
    expect(mocks.callMock).toHaveBeenCalledWith('jira.updateIssue', {
      key: issue.key,
      siteId: site.id,
      updates: { transitionId: '31' }
    })
  })

  it.each([{ transitions: [] }, { transitions: [transition, { ...transition, id: '32' }] }])(
    'refuses absent or ambiguous transitions',
    async ({ transitions }) => {
      await run(['status', 'set', 'ENG-123', '--to', 'In Progress'], {
        'jira.listTransitions': transitions
      })
      expect(mocks.callMock).not.toHaveBeenCalledWith('jira.updateIssue', expect.anything())
    }
  )

  it.each([
    ['assignee', 'set', ['--to-id', 'account-9'], { assigneeAccountId: 'account-9' }],
    ['assignee', 'clear', [], { assigneeAccountId: null }],
    ['priority', 'set', ['--to-id', '2'], { priorityId: '2' }],
    ['priority', 'clear', [], { priorityId: null }],
    ['label', 'set', ['--label', 'bug', '--label', 'urgent'], { labels: ['bug', 'urgent'] }],
    ['label', 'add', ['--label', 'bug'], { labelOperations: { add: ['bug'] } }],
    ['label', 'rm', ['--label', 'bug'], { labelOperations: { remove: ['bug'] } }]
  ])('maps %s %s to a site-pinned mutation', async (noun, verb, flags, updates) => {
    await run([noun, verb, 'ENG-123', ...flags])
    expect(mocks.callMock).toHaveBeenCalledWith('jira.updateIssue', {
      key: issue.key,
      siteId: site.id,
      updates
    })
    expect(mocks.callMock).not.toHaveBeenCalledWith('jira.getIssue', expect.anything())
  })

  it('does not report rejected mutations as successful', async () => {
    await run(['label', 'add', 'ENG-123', '--label', 'bug'], {
      'jira.updateIssue': { ok: false, error: 'Permission denied' }
    })
    expect(errorOutput()).toMatchObject({
      error: {
        code: 'jira_write_failed',
        message: expect.stringContaining('Permission denied')
      }
    })
  })

  it('preserves uncertainty when the host returns a failed comment result', async () => {
    await run(['comment', 'add', 'ENG-123', '--body', 'Ready'], {
      'jira.addIssueComment': { ok: false, error: 'Connection closed while reading the response' }
    })
    expect(errorOutput()).toMatchObject({
      error: {
        code: 'jira_write_failed',
        message: expect.stringContaining('Verify in Jira before retrying')
      }
    })
    expect(
      mocks.callMock.mock.calls.filter(([method]) => method === 'jira.addIssueComment')
    ).toHaveLength(1)
  })

  it('does not retry a timed-out write or claim it did not happen', async () => {
    responses()
    const previous = mocks.callMock.getMockImplementation()
    mocks.callMock.mockImplementation(async (method: string, ...args: unknown[]) => {
      if (method === 'jira.addIssueComment') {
        throw new RuntimeClientError('runtime_timeout', 'Timed out')
      }
      return previous?.(method, ...args)
    })
    await main(['jira', 'comment', 'add', 'ENG-123', '--body', 'Ready', '--json'], '/tmp/workspace')
    expect(errorOutput()).toMatchObject({
      error: {
        code: 'jira_write_unverified',
        message: expect.stringContaining('Verify in Jira before retrying')
      }
    })
    expect(
      mocks.callMock.mock.calls.filter(([method]) => method === 'jira.addIssueComment')
    ).toHaveLength(1)
  })
})

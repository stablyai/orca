import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
import { pairRuntimeEnvironment, useWorktreeAwarenessEnvironment } from './index-test-harness'
import { buildWorktree, okFixture } from './test-fixtures'
import { RuntimeClientError } from './runtime/types'
import { JIRA_AGENT_ACCESS_RUNTIME_CAPABILITY } from '../shared/jira/jira-agent-capability'
import { WORKTREE_LINKED_ITEMS_DELTA_RUNTIME_CAPABILITY } from '../shared/workspace-attachment-capabilities'

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
  labels: [],
  updatedAt: '2026-10-13',
  createdAt: '2026-10-12'
}
const jiraReference = {
  provider: 'jira' as const,
  type: 'issue' as const,
  number: 0,
  identifier: 'ENG-123',
  jiraIdentifier: 'ENG-123',
  url: issue.url
}
const attachment = { ...jiraReference, title: issue.title }
const reviewUrl = 'https://gitlab.com/acme/api/-/merge_requests/12'
const review = { provider: 'gitlab' as const, type: 'mr' as const, number: 12, url: reviewUrl }
const workspace = { ...buildWorktree('/tmp/api', 'api'), kind: 'worktree', name: 'api' }
const addArgs = ['reference', 'add', 'eng-123', '--worktree', 'name:api']
const createArgs = [
  'worktree',
  'create',
  '--name',
  'fix',
  '--repo',
  'id:repo',
  '--no-parent',
  '--reference',
  'eng-123',
  '--json'
]

function responses(overrides: Record<string, unknown> = {}): void {
  const values: Record<string, unknown> = {
    'status.get': {
      capabilities: [
        JIRA_AGENT_ACCESS_RUNTIME_CAPABILITY,
        WORKTREE_LINKED_ITEMS_DELTA_RUNTIME_CAPABILITY
      ]
    },
    'jira.status': { sites: [site], selectedSiteId: site.id },
    'jira.lookupIssueSummary': issue,
    'reference.list': { worktree: workspace, references: [] },
    'worktree.create': { worktree: workspace },
    ...overrides
  }
  mocks.callMock.mockImplementation(async (method: string) => {
    const result = values[method]
    if (result instanceof Error) {
      throw result
    }
    return okFixture(method, result)
  })
}

function expectNoWrite(): void {
  expect(mocks.callMock.mock.calls.map(([method]) => method)).not.toContain('worktree.set')
  expect(mocks.callMock.mock.calls.map(([method]) => method)).not.toContain('worktree.create')
  expect(mocks.callMock.mock.calls.map(([method]) => method)).not.toContain(
    'folderWorkspace.update'
  )
}

describe('Jira reference keys', () => {
  const priorExitCode = process.exitCode
  beforeEach(() => {
    process.exitCode = undefined
  })
  afterEach(() => {
    process.exitCode = priorExitCode
  })
  useWorktreeAwarenessEnvironment(mocks)
  beforeEach(() => {
    mocks.runtimeClientConstructorMock.mockClear()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    pairRuntimeEnvironment(mocks.listEnvironmentsMock, 'remote')
    responses()
  })

  it('adds a lowercase Jira key with its title using existing delta storage', async () => {
    await main(addArgs, '/tmp/api')
    expect(mocks.callMock).toHaveBeenCalledWith('jira.lookupIssueSummary', {
      key: 'ENG-123',
      siteId: site.id
    })
    expect(mocks.callMock).toHaveBeenCalledWith(
      'worktree.set',
      expect.objectContaining({
        worktree: 'id:repo::/tmp/api',
        linkedItemsBase: [],
        linkedItems: [attachment],
        linkedItemsSelectionChanged: false
      })
    )
  })

  it('uses the selected execution host for Jira lookup and workspace mutation', async () => {
    await main([...addArgs, '--environment', 'remote'], '/tmp/api')
    expect(mocks.runtimeClientConstructorMock).toHaveBeenCalledExactlyOnceWith(undefined, 'remote')
    expect(mocks.callMock).toHaveBeenCalledWith('jira.lookupIssueSummary', {
      key: 'ENG-123',
      siteId: site.id
    })
    expect(mocks.callMock).toHaveBeenCalledWith('reference.list', { worktree: 'name:api' })
    expect(mocks.callMock).toHaveBeenCalledWith('worktree.set', {
      worktree: 'id:repo::/tmp/api',
      linkedItemsBase: [],
      linkedItems: [attachment],
      linkedItemsSelectionChanged: false
    })
  })

  it('refuses ambiguous sites rather than using activeSiteId', async () => {
    responses({
      'jira.status': {
        sites: [site, { ...site, id: 'other' }],
        selectedSiteId: 'all',
        activeSiteId: site.id
      }
    })
    await main(addArgs, '/tmp/api')
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('--reference-site'))
    expectNoWrite()
    expect(mocks.callMock).not.toHaveBeenCalledWith('jira.lookupIssueSummary', expect.anything())
  })

  it.each(['all', 'missing'])('rejects invalid explicit site %s before lookup', async (id) => {
    await main([...addArgs, '--reference-site', id], '/tmp/api')
    expect(console.error).toHaveBeenCalledExactlyOnceWith(
      id === 'all'
        ? 'Choose one Jira site ID; --reference-site all is unsupported.'
        : 'No matching connected Jira site. Check orca jira connection and Orca Jira settings.'
    )
    expect(process.exitCode).toBe(1)
    expect(mocks.callMock).not.toHaveBeenCalledWith('jira.lookupIssueSummary', expect.anything())
    expectNoWrite()
  })

  it('selects an explicit site including a Server context path', async () => {
    const server = {
      ...site,
      id: 'server',
      siteUrl: 'https://jira.example/jira',
      authType: 'server'
    }
    const serverIssue = { ...issue, siteId: server.id, url: `${server.siteUrl}/browse/ENG-123` }
    responses({
      'jira.status': { sites: [site, server], selectedSiteId: 'all' },
      'jira.lookupIssueSummary': serverIssue
    })
    await main([...addArgs, '--reference-site', server.id], '/tmp/api')
    expect(mocks.callMock).toHaveBeenCalledWith('jira.lookupIssueSummary', {
      key: 'ENG-123',
      siteId: server.id
    })
    expect(mocks.callMock).toHaveBeenCalledWith(
      'worktree.set',
      expect.objectContaining({
        linkedItems: [{ ...attachment, url: serverIssue.url }]
      })
    )
  })

  it.each([
    null,
    { ...issue, key: 'ENG-124' },
    { ...issue, siteId: 'other' },
    { ...issue, url: 'https://example.atlassian.net.evil.example/browse/ENG-123' },
    { ...issue, url: `${site.siteUrl}/other/browse/ENG-123` },
    { ...issue, url: `${site.siteUrl}/browse/ENG-124` },
    { ...issue, title: '' }
  ])('rejects an absent or mismatched summary %#', async (summary) => {
    responses({ 'jira.lookupIssueSummary': summary })
    await main(addArgs, '/tmp/api')
    expect(mocks.callMock).toHaveBeenCalledWith('jira.lookupIssueSummary', {
      key: 'ENG-123',
      siteId: site.id
    })
    expect(console.error).toHaveBeenCalledExactlyOnceWith(
      'Jira did not return issue ENG-123 with a title on the selected site.'
    )
    expect(process.exitCode).toBe(1)
    expectNoWrite()
  })

  it('preserves Jira lookup errors without reading or updating workspace storage', async () => {
    responses({
      'jira.lookupIssueSummary': new RuntimeClientError('rpc_error', 'jira_summary_lookup:auth')
    })
    await main(addArgs, '/tmp/api')
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('jira_summary_lookup:auth'))
    expect(mocks.callMock).not.toHaveBeenCalledWith('reference.list', expect.anything())
    expectNoWrite()
  })

  it('validates mixed URLs and keys before any request', async () => {
    await main(
      ['reference', 'add', 'ENG-123', reviewUrl, 'invalid', '--worktree', 'name:api'],
      '/tmp/api'
    )
    expect(mocks.callMock).not.toHaveBeenCalled()
  })

  it('deduplicates a key and its URL without losing the resolved title', async () => {
    await main(
      ['reference', 'add', reviewUrl, 'eng-123', issue.url, 'ENG-123', '--worktree', 'name:api'],
      '/tmp/api'
    )
    expect(mocks.callMock).toHaveBeenCalledWith(
      'worktree.set',
      expect.objectContaining({
        linkedItems: [review, attachment]
      })
    )
    expect(
      mocks.callMock.mock.calls.filter(([method]) => method === 'jira.lookupIssueSummary')
    ).toHaveLength(1)
  })

  it('keeps stored metadata for an already linked issue and produces no write', async () => {
    const stored = { ...attachment, title: 'Existing title' }
    responses({
      'reference.list': {
        worktree: workspace,
        references: [
          {
            ...stored,
            key: '["jira","issue","example.atlassian.net","/browse/ENG-123"]',
            selected: false
          }
        ]
      }
    })
    await main([...addArgs, '--json'], '/tmp/api')
    expectNoWrite()
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0][0]).result.changes[0]).toMatchObject({
      changed: false,
      reason: 'already_linked'
    })
  })

  it('adds to a folder through the existing folder update', async () => {
    responses({
      'reference.list': {
        worktree: { ...workspace, id: 'folder:folder1', kind: 'folder' },
        references: []
      }
    })
    await main(addArgs, '/tmp/api')
    expect(mocks.callMock).toHaveBeenCalledWith('folderWorkspace.update', {
      folderWorkspaceId: 'folder1',
      updates: {
        linkedItemsBase: [],
        linkedItems: [attachment],
        linkedItemsSelectionChanged: false
      }
    })
  })

  it('resolves create references before workspace creation', async () => {
    await main(createArgs, '/tmp/api')
    const methods = mocks.callMock.mock.calls.map(([method]) => method)
    expect(methods).toContain('jira.lookupIssueSummary')
    expect(methods.indexOf('jira.lookupIssueSummary')).toBeLessThan(
      methods.indexOf('worktree.create')
    )
    expect(mocks.callMock).toHaveBeenCalledWith(
      'worktree.create',
      expect.objectContaining({ linkedItems: [attachment] })
    )
  })

  it('creates nothing when the Jira reference cannot resolve', async () => {
    responses({ 'jira.lookupIssueSummary': null })
    await main(createArgs, '/tmp/api')
    expect(mocks.callMock).toHaveBeenCalledWith('jira.lookupIssueSummary', {
      key: 'ENG-123',
      siteId: site.id
    })
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0][0])).toMatchObject({
      ok: false,
      error: {
        code: 'jira_issue_unavailable',
        message: 'Jira did not return issue ENG-123 with a title on the selected site.'
      }
    })
    expect(process.exitCode).toBe(1)
    expectNoWrite()
  })

  it('creates with an explicitly selected Jira site', async () => {
    responses({
      'jira.status': {
        sites: [site, { ...site, id: 'other' }],
        selectedSiteId: 'all'
      }
    })
    await main([...createArgs, '--reference-site', site.id], '/tmp/api')
    expect(mocks.callMock).toHaveBeenCalledWith('jira.lookupIssueSummary', {
      key: 'ENG-123',
      siteId: site.id
    })
    expect(mocks.callMock).toHaveBeenCalledWith(
      'worktree.create',
      expect.objectContaining({ linkedItems: [attachment] })
    )
  })

  it('writes nothing if a later Jira key does not resolve', async () => {
    await main(['reference', 'add', 'ENG-123', 'ENG-124', '--worktree', 'name:api'], '/tmp/api')
    expect(mocks.callMock).toHaveBeenCalledWith('jira.lookupIssueSummary', {
      key: 'ENG-124',
      siteId: site.id
    })
    expect(
      mocks.callMock.mock.calls
        .filter(([method]) => method === 'jira.lookupIssueSummary')
        .map(([, params]) => params)
    ).toEqual([
      { key: 'ENG-123', siteId: site.id },
      { key: 'ENG-124', siteId: site.id }
    ])
    expect(console.error).toHaveBeenCalledExactlyOnceWith(
      'Jira did not return issue ENG-124 with a title on the selected site.'
    )
    expect(process.exitCode).toBe(1)
    expectNoWrite()
  })

  it('validates required create flags before Jira lookup', async () => {
    await main(
      ['worktree', 'create', '--repo', 'id:repo', '--no-parent', '--reference', 'ENG-123'],
      '/tmp/api'
    )
    expect(mocks.callMock).not.toHaveBeenCalled()
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('--name'))
  })

  it('keeps full Jira URLs usable without a saved Jira connection', async () => {
    responses({ 'status.get': { capabilities: [WORKTREE_LINKED_ITEMS_DELTA_RUNTIME_CAPABILITY] } })
    await main(['reference', 'add', issue.url, '--worktree', 'name:api'], '/tmp/api')
    expect(mocks.callMock.mock.calls.map(([method]) => method)).not.toContain('jira.status')
    expect(mocks.callMock).toHaveBeenCalledWith(
      'worktree.set',
      expect.objectContaining({
        linkedItems: [jiraReference]
      })
    )
  })

  it('requires Jira agent capability before resolving keys', async () => {
    responses({ 'status.get': { capabilities: [WORKTREE_LINKED_ITEMS_DELTA_RUNTIME_CAPABILITY] } })
    await main(addArgs, '/tmp/api')
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Update Orca'))
    expect(mocks.callMock.mock.calls.map(([method]) => method)).not.toContain('jira.status')
    expectNoWrite()
  })
})

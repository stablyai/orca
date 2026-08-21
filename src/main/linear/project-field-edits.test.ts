import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinearClientForWorkspace } from './client'

const rawRequest = vi.fn()
const updateProject = vi.fn()
const getClients = vi.fn()
const clearToken = vi.fn()
const isAuthError = vi.fn()
const linearClientOptions: { apiKey?: string; signal?: AbortSignal }[] = []
const signalRawRequest = vi.fn()
const signalUpdateProject = vi.fn()

vi.mock('./linear-request-concurrency', () => ({
  acquire: vi.fn().mockResolvedValue(undefined),
  release: vi.fn()
}))

vi.mock('./linear-token-store', () => ({
  clearToken: (...args: unknown[]) => clearToken(...args)
}))

vi.mock('./client', () => ({
  getClients: (...args: unknown[]) => getClients(...args),
  isAuthError: (...args: unknown[]) => isAuthError(...args)
}))

vi.mock('./linear-sdk', () => ({
  loadLinearSdk: () => ({
    AuthenticationLinearError: class extends Error {},
    LinearClient: class {
      client = { rawRequest: signalRawRequest }
      updateProject = signalUpdateProject
      constructor(options: { apiKey?: string; signal?: AbortSignal }) {
        linearClientOptions.push(options)
      }
    }
  })
}))

function entry(): LinearClientForWorkspace {
  return {
    apiKey: 'lin_api_key',
    workspace: {
      id: 'workspace-1',
      organizationId: 'workspace-1',
      organizationName: 'Acme',
      displayName: 'Ada',
      email: 'ada@example.com'
    },
    client: { updateProject, client: { rawRequest } }
  } as unknown as LinearClientForWorkspace
}

function projectNode(overrides: Record<string, unknown> = {}) {
  return {
    id: 'project-1',
    name: 'Importer',
    slugId: 'importer-abc',
    url: 'https://linear.app/acme/project/importer-abc',
    description: 'Old summary',
    content: 'Old overview',
    color: '#5e6ad2',
    icon: 'Rocket',
    priority: 3,
    startDate: '2026-01-01',
    targetDate: '2026-02-01',
    status: { id: 'status-1', name: 'In progress', type: 'started', color: '#0f0' },
    lead: { id: 'user-1', displayName: 'Ada', avatarUrl: null },
    members: {
      nodes: [{ id: 'user-1', displayName: 'Ada', avatarUrl: null }],
      pageInfo: { hasNextPage: false, endCursor: null }
    },
    teams: {
      nodes: [{ id: 'team-1', name: 'Core', key: 'CORE' }],
      pageInfo: { hasNextPage: false, endCursor: null }
    },
    labels: {
      nodes: [{ id: 'label-1', name: 'Platform', color: '#fff', isGroup: false, parent: null }],
      pageInfo: { hasNextPage: false, endCursor: null }
    },
    ...overrides
  }
}

/** Queues the pre-read and the post-mutation read-back for one edit call. */
function queueReads(before: Record<string, unknown>, after = before): void {
  rawRequest
    .mockResolvedValueOnce({ data: { project: before } })
    .mockResolvedValueOnce({ data: { project: after } })
}

describe('Linear project field edits', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Why: mockClear keeps queued once-responses, which would leak into the next test's reads.
    for (const mock of [rawRequest, updateProject, signalRawRequest, signalUpdateProject]) {
      mock.mockReset()
    }
    linearClientOptions.length = 0
    isAuthError.mockReturnValue(false)
    getClients.mockReturnValue([entry()])
    updateProject.mockResolvedValue({ success: true })
    signalUpdateProject.mockResolvedValue({ success: true })
  })

  it('sends only the differing requested fields and never touches unrequested ones', async () => {
    queueReads(projectNode(), projectNode({ description: 'New summary' }))
    const { editProjectFieldsForAgent } = await import('./project-field-edits')

    const outcome = await editProjectFieldsForAgent(
      'project-1',
      // Why: name and priority already match, so only description may reach the mutation.
      { description: 'New summary', name: 'Importer', priority: 3 },
      'workspace-1'
    )

    expect(updateProject).toHaveBeenCalledTimes(1)
    expect(updateProject).toHaveBeenCalledWith('project-1', { description: 'New summary' })
    expect(outcome.noop).toBe(false)
    expect(outcome.previous.description).toBe('Old summary')
    expect(outcome.current.description).toBe('New summary')
    expect(outcome.current.content).toBe('Old overview')
  })

  // Why: a rename moves name, slugId and url together, so the reported identity has to
  // come from the read-back rather than from the target the caller resolved before the edit.
  it('reports the post-edit project identity after a rename', async () => {
    queueReads(
      projectNode(),
      projectNode({
        name: 'Importer V2',
        slugId: 'importer-v2-abc',
        url: 'https://linear.app/acme/project/importer-v2-abc'
      })
    )
    const { editProjectFieldsForAgent } = await import('./project-field-edits')

    const outcome = await editProjectFieldsForAgent(
      'project-1',
      { name: 'Importer V2' },
      'workspace-1'
    )

    expect(outcome.project).toEqual({
      id: 'project-1',
      name: 'Importer V2',
      slugId: 'importer-v2-abc',
      url: 'https://linear.app/acme/project/importer-v2-abc'
    })
  })

  it('reports the unchanged project identity for a no-op edit', async () => {
    rawRequest.mockResolvedValueOnce({ data: { project: projectNode() } })
    const { editProjectFieldsForAgent } = await import('./project-field-edits')

    const outcome = await editProjectFieldsForAgent(
      'project-1',
      { name: 'Importer' },
      'workspace-1'
    )

    expect(outcome.noop).toBe(true)
    expect(outcome.project).toMatchObject({ id: 'project-1', slugId: 'importer-abc' })
  })

  it('normalizes prose line endings before comparing and mutating', async () => {
    queueReads(projectNode(), projectNode({ content: 'one\ntwo' }))
    const { editProjectFieldsForAgent } = await import('./project-field-edits')

    await editProjectFieldsForAgent('project-1', { content: 'one\r\ntwo' }, 'workspace-1')

    expect(updateProject).toHaveBeenCalledWith('project-1', { content: 'one\ntwo' })
  })

  it('issues no mutation when every requested field already matches', async () => {
    rawRequest.mockResolvedValueOnce({ data: { project: projectNode() } })
    const { editProjectFieldsForAgent } = await import('./project-field-edits')

    const outcome = await editProjectFieldsForAgent(
      'project-1',
      {
        name: 'Importer',
        description: 'Old summary',
        content: 'Old overview',
        statusId: 'status-1',
        leadId: 'user-1',
        memberIds: ['user-1'],
        teamIds: ['team-1'],
        labelIds: ['label-1'],
        priority: 3,
        startDate: '2026-01-01',
        targetDate: '2026-02-01',
        color: '#5e6ad2'
      },
      'workspace-1'
    )

    expect(updateProject).not.toHaveBeenCalled()
    expect(outcome.noop).toBe(true)
    expect(outcome.previous).toEqual(outcome.current)
    expect(rawRequest).toHaveBeenCalledTimes(1)
  })

  // Why: Linear's stored casing for a hex color is not guaranteed to match the
  // request's casing, so a same-color edit sent in a different case must not
  // read as a change, and a real change confirmed by a differently-cased
  // read-back must not be reported as unconfirmed.
  it('compares --color case-insensitively against the stored value', async () => {
    rawRequest.mockResolvedValueOnce({ data: { project: projectNode() } })
    const { editProjectFieldsForAgent } = await import('./project-field-edits')

    const outcome = await editProjectFieldsForAgent(
      'project-1',
      { color: '#5E6AD2' },
      'workspace-1'
    )

    expect(updateProject).not.toHaveBeenCalled()
    expect(outcome.noop).toBe(true)
  })

  it('confirms a color edit even when the read-back casing differs from the request', async () => {
    queueReads(projectNode({ color: '#5e6ad2' }), projectNode({ color: '#AABBCC' }))
    updateProject.mockResolvedValueOnce({ success: true })
    const { editProjectFieldsForAgent } = await import('./project-field-edits')

    const outcome = await editProjectFieldsForAgent(
      'project-1',
      { color: '#aabbcc' },
      'workspace-1'
    )

    expect(outcome.noop).toBe(false)
    expect(updateProject).toHaveBeenCalledTimes(1)
  })

  /** Reads one snapshot through the real record shape, then clears the queued reads. */
  async function readSnapshot(projectId: string, node: Record<string, unknown>) {
    rawRequest.mockResolvedValueOnce({ data: { project: node } })
    const { getProjectByIdForAgent } = await import('./project-create')
    const record = await getProjectByIdForAgent(projectId, 'workspace-1')
    if (!record) {
      throw new Error('expected a project record')
    }
    rawRequest.mockReset()
    return record
  }

  // Why: the caller reads the pre-edit snapshot outside the write deadline, so supplying it
  // has to skip the pre-read entirely rather than read the same project twice.
  it('uses a caller-supplied snapshot instead of reading the project again', async () => {
    const previous = await readSnapshot('project-1', projectNode())
    rawRequest.mockResolvedValueOnce({
      data: { project: projectNode({ description: 'New summary' }) }
    })
    const { editProjectFieldsForAgent } = await import('./project-field-edits')

    const outcome = await editProjectFieldsForAgent(
      'project-1',
      { description: 'New summary' },
      'workspace-1',
      { previous }
    )

    expect(updateProject).toHaveBeenCalledWith('project-1', { description: 'New summary' })
    // Why: only the post-mutation read-back remains; the pre-read never ran.
    expect(rawRequest).toHaveBeenCalledTimes(1)
    expect(outcome.previous.description).toBe('Old summary')
    expect(outcome.current.description).toBe('New summary')
  })

  it('refuses a caller-supplied snapshot that belongs to another project', async () => {
    const previous = await readSnapshot('project-2', projectNode({ id: 'project-2' }))
    const { editProjectFieldsForAgent } = await import('./project-field-edits')

    await expect(
      editProjectFieldsForAgent('project-1', { description: 'New summary' }, 'workspace-1', {
        previous
      })
    ).rejects.toMatchObject({ kind: 'failed' })
    expect(updateProject).not.toHaveBeenCalled()
    expect(rawRequest).not.toHaveBeenCalled()
  })

  it('forwards clear intents as empty string, null and empty arrays exactly', async () => {
    queueReads(
      projectNode(),
      projectNode({
        description: '',
        content: null,
        lead: null,
        startDate: null,
        targetDate: null,
        members: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        labels: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } }
      })
    )
    const { editProjectFieldsForAgent } = await import('./project-field-edits')

    await editProjectFieldsForAgent(
      'project-1',
      {
        description: '',
        content: null,
        leadId: null,
        startDate: null,
        targetDate: null,
        memberIds: [],
        labelIds: []
      },
      'workspace-1'
    )

    // Why: every clear travels as its own null/empty form except content, which
    // Linear ignores unless the write carries whitespace.
    expect(updateProject).toHaveBeenCalledWith('project-1', {
      description: '',
      content: ' ',
      leadId: null,
      startDate: null,
      targetDate: null,
      memberIds: [],
      labelIds: []
    })
  })

  it('keeps an empty description distinct from a cleared content value', async () => {
    rawRequest.mockResolvedValueOnce({
      data: { project: projectNode({ description: '', content: null }) }
    })
    const { editProjectFieldsForAgent } = await import('./project-field-edits')

    const outcome = await editProjectFieldsForAgent(
      'project-1',
      { description: '', content: null },
      'workspace-1'
    )

    expect(outcome.noop).toBe(true)
    expect(outcome.current.description).toBe('')
    expect(outcome.current.content).toBeNull()
  })

  it('rejects an empty edit, a blank name and an empty team replacement before any read', async () => {
    const { editProjectFieldsForAgent } = await import('./project-field-edits')

    await expect(editProjectFieldsForAgent('project-1', {}, 'workspace-1')).rejects.toMatchObject({
      kind: 'failed',
      name: 'LinearWriteFailure'
    })
    await expect(
      editProjectFieldsForAgent('project-1', { name: '  ' }, 'workspace-1')
    ).rejects.toMatchObject({ kind: 'failed' })
    await expect(
      editProjectFieldsForAgent('project-1', { teamIds: [] }, 'workspace-1')
    ).rejects.toMatchObject({ kind: 'failed' })
    expect(rawRequest).not.toHaveBeenCalled()
    expect(updateProject).not.toHaveBeenCalled()
  })

  it('pages every collection past its first page and compares ids as sets', async () => {
    rawRequest
      .mockResolvedValueOnce({
        data: {
          project: projectNode({
            members: {
              nodes: [{ id: 'user-1', displayName: 'Ada', avatarUrl: null }],
              pageInfo: { hasNextPage: true, endCursor: 'c1' }
            }
          })
        }
      })
      .mockResolvedValueOnce({
        data: {
          project: {
            members: {
              nodes: [{ id: 'user-2', displayName: 'Grace', avatarUrl: null }],
              pageInfo: { hasNextPage: false, endCursor: 'c2' }
            }
          }
        }
      })
    const { editProjectFieldsForAgent } = await import('./project-field-edits')

    const outcome = await editProjectFieldsForAgent(
      'project-1',
      // Why: the second page holds user-2 — a first-page-only read would wrongly replace the members.
      { memberIds: ['user-2', 'user-1', 'user-1'] },
      'workspace-1'
    )

    expect(updateProject).not.toHaveBeenCalled()
    expect(outcome.noop).toBe(true)
    expect(outcome.current.members.map((member) => member.id)).toEqual(['user-1', 'user-2'])
    expect(rawRequest).toHaveBeenCalledTimes(2)
    expect(rawRequest.mock.calls[1]?.[1]).toMatchObject({ id: 'project-1', after: 'c1' })
  })

  it('deduplicates resolved ids before the mutation', async () => {
    queueReads(
      projectNode(),
      projectNode({
        teams: {
          nodes: [
            { id: 'team-1', name: 'Core', key: 'CORE' },
            { id: 'team-2', name: 'Growth', key: 'GRO' }
          ],
          pageInfo: { hasNextPage: false, endCursor: null }
        }
      })
    )
    const { editProjectFieldsForAgent } = await import('./project-field-edits')

    await editProjectFieldsForAgent(
      'project-1',
      { teamIds: ['team-1', 'team-2', 'team-1'] },
      'workspace-1'
    )

    expect(updateProject).toHaveBeenCalledWith('project-1', { teamIds: ['team-1', 'team-2'] })
  })

  it('fails when the mutation reports success: false', async () => {
    rawRequest.mockResolvedValueOnce({ data: { project: projectNode() } })
    updateProject.mockResolvedValueOnce({ success: false })
    const { editProjectFieldsForAgent } = await import('./project-field-edits')

    await expect(
      editProjectFieldsForAgent('project-1', { name: 'Renamed' }, 'workspace-1')
    ).rejects.toMatchObject({ kind: 'failed' })
    expect(rawRequest).toHaveBeenCalledTimes(1)
  })

  // Why: a field edit has no caller-supplied id to dedup a retry against, so a
  // Linear "already exists"-shaped message must not escape as a raw, unmapped
  // duplicate_id failure — it has to become unconfirmed like any other write
  // whose outcome only the read-back can settle.
  it('treats a duplicate_id-shaped write failure as unconfirmed, not a raw escape', async () => {
    rawRequest.mockResolvedValueOnce({ data: { project: projectNode() } })
    updateProject.mockRejectedValueOnce(new Error('Project name already exists'))
    const { editProjectFieldsForAgent } = await import('./project-field-edits')

    await expect(
      editProjectFieldsForAgent('project-1', { name: 'Renamed' }, 'workspace-1')
    ).rejects.toMatchObject({ kind: 'unconfirmed' })
  })

  it('treats a read-back mismatch as unconfirmed', async () => {
    queueReads(projectNode())
    const { editProjectFieldsForAgent } = await import('./project-field-edits')

    await expect(
      editProjectFieldsForAgent('project-1', { name: 'Renamed' }, 'workspace-1')
    ).rejects.toMatchObject({ kind: 'unconfirmed' })
    expect(updateProject).toHaveBeenCalledWith('project-1', { name: 'Renamed' })
  })

  // Why: Linear rewrites content Markdown as it stores it, so a successful write
  // never reads back byte-identical. Verifying by spelling reported these as
  // unconfirmed and sent callers to `project show` for a write that had landed.
  it('accepts a content read-back that Linear rewrote', async () => {
    const url = 'https://example.com/x'
    queueReads(projectNode(), projectNode({ content: `see [${url}](<${url}>) end` }))
    const { editProjectFieldsForAgent } = await import('./project-field-edits')

    const outcome = await editProjectFieldsForAgent(
      'project-1',
      { content: `see ${url} end` },
      'workspace-1'
    )

    expect(outcome.noop).toBe(false)
    expect(updateProject).toHaveBeenCalledWith('project-1', { content: `see ${url} end` })
    expect(outcome.current.content).toBe(`see [${url}](<${url}>) end`)
  })

  it('accepts a content read-back whose trailing newline Linear stripped', async () => {
    queueReads(projectNode(), projectNode({ content: 'from a file' }))
    const { editProjectFieldsForAgent } = await import('./project-field-edits')

    const outcome = await editProjectFieldsForAgent(
      'project-1',
      { content: 'from a file\n' },
      'workspace-1'
    )

    expect(outcome.noop).toBe(false)
    expect(outcome.current.content).toBe('from a file')
  })

  // Why: without this the same --content-file body re-mutates on every run,
  // because the stored rewrite never equals the text on disk.
  it('treats re-sending a body Linear already rewrote as a no-op', async () => {
    const url = 'https://example.com/x'
    rawRequest.mockResolvedValueOnce({
      data: { project: projectNode({ content: `see [${url}](<${url}>) end` }) }
    })
    const { editProjectFieldsForAgent } = await import('./project-field-edits')

    const outcome = await editProjectFieldsForAgent(
      'project-1',
      { content: `see ${url} end` },
      'workspace-1'
    )

    expect(outcome.noop).toBe(true)
    expect(updateProject).not.toHaveBeenCalled()
  })

  // Why: Linear reports success and keeps the old body when content is written as
  // null or '', so --clear-content used to be a flag that could only ever fail.
  it('sends a content clear as whitespace so Linear actually applies it', async () => {
    queueReads(projectNode(), projectNode({ content: '' }))
    const { editProjectFieldsForAgent } = await import('./project-field-edits')

    const outcome = await editProjectFieldsForAgent('project-1', { content: null }, 'workspace-1')

    expect(updateProject).toHaveBeenCalledWith('project-1', { content: ' ' })
    expect(outcome.noop).toBe(false)
  })

  it('treats clearing an already-empty overview as a no-op', async () => {
    rawRequest.mockResolvedValueOnce({ data: { project: projectNode({ content: '' }) } })
    const { editProjectFieldsForAgent } = await import('./project-field-edits')

    const outcome = await editProjectFieldsForAgent('project-1', { content: null }, 'workspace-1')

    expect(outcome.noop).toBe(true)
    expect(updateProject).not.toHaveBeenCalled()
  })

  it('still treats a truncated content read-back as unconfirmed', async () => {
    queueReads(projectNode(), projectNode({ content: 'the whole' }))
    const { editProjectFieldsForAgent } = await import('./project-field-edits')

    await expect(
      editProjectFieldsForAgent('project-1', { content: 'the whole overview' }, 'workspace-1')
    ).rejects.toMatchObject({ kind: 'unconfirmed' })
  })

  it('treats a collection read-back that lost an id as unconfirmed', async () => {
    queueReads(
      projectNode(),
      projectNode({
        labels: {
          nodes: [{ id: 'label-2', name: 'Infra', color: '#fff', isGroup: false, parent: null }],
          pageInfo: { hasNextPage: false, endCursor: null }
        }
      })
    )
    const { editProjectFieldsForAgent } = await import('./project-field-edits')

    await expect(
      editProjectFieldsForAgent('project-1', { labelIds: ['label-2', 'label-3'] }, 'workspace-1')
    ).rejects.toMatchObject({ kind: 'unconfirmed' })
  })

  it('treats a read-back transport failure and a vanished project as unconfirmed', async () => {
    rawRequest
      .mockResolvedValueOnce({ data: { project: projectNode() } })
      .mockRejectedValueOnce(new Error('fetch failed: socket hang up'))
    const { editProjectFieldsForAgent } = await import('./project-field-edits')

    await expect(
      editProjectFieldsForAgent('project-1', { name: 'Renamed' }, 'workspace-1')
    ).rejects.toMatchObject({ kind: 'unconfirmed' })

    rawRequest
      .mockResolvedValueOnce({ data: { project: projectNode() } })
      .mockResolvedValueOnce({ data: { project: null } })
    await expect(
      editProjectFieldsForAgent('project-1', { name: 'Renamed' }, 'workspace-1')
    ).rejects.toMatchObject({ kind: 'unconfirmed' })
  })

  it('fails before mutating when the project cannot be read', async () => {
    rawRequest.mockResolvedValueOnce({ data: { project: null } })
    const { editProjectFieldsForAgent } = await import('./project-field-edits')

    await expect(
      editProjectFieldsForAgent('project-1', { name: 'Renamed' }, 'workspace-1')
    ).rejects.toMatchObject({ kind: 'failed' })
    expect(updateProject).not.toHaveBeenCalled()
  })

  it('propagates the abort signal to the pre-read, the mutation and the read-back', async () => {
    const controller = new AbortController()
    signalRawRequest
      .mockResolvedValueOnce({ data: { project: projectNode() } })
      .mockResolvedValueOnce({ data: { project: projectNode({ name: 'Renamed' }) } })
    const { editProjectFieldsForAgent } = await import('./project-field-edits')

    await editProjectFieldsForAgent('project-1', { name: 'Renamed' }, 'workspace-1', {
      signal: controller.signal
    })

    expect(linearClientOptions.every((options) => options.signal === controller.signal)).toBe(true)
    expect(signalUpdateProject).toHaveBeenCalledTimes(1)
    expect(signalRawRequest).toHaveBeenCalledTimes(2)
    expect(rawRequest).not.toHaveBeenCalled()
    expect(updateProject).not.toHaveBeenCalled()
  })

  it('clears the token and rethrows when the workspace auth expired', async () => {
    rawRequest.mockResolvedValueOnce({ data: { project: projectNode() } })
    updateProject.mockRejectedValueOnce(new Error('authentication failed'))
    isAuthError.mockReturnValue(true)
    const { editProjectFieldsForAgent } = await import('./project-field-edits')

    await expect(
      editProjectFieldsForAgent('project-1', { name: 'Renamed' }, 'workspace-1')
    ).rejects.toThrow('authentication failed')
    expect(clearToken).toHaveBeenCalledWith('workspace-1')
  })

  it('fails closed when the workspace has no connected client', async () => {
    getClients.mockReturnValue([])
    const { editProjectFieldsForAgent } = await import('./project-field-edits')

    await expect(
      editProjectFieldsForAgent('project-1', { name: 'Renamed' }, 'workspace-1')
    ).rejects.toMatchObject({ kind: 'failed' })
    expect(rawRequest).not.toHaveBeenCalled()
  })

  it('lists only the requested fields that actually changed, in editable-field order', async () => {
    rawRequest.mockResolvedValueOnce({ data: { project: projectNode() } }).mockResolvedValueOnce({
      data: {
        project: projectNode({
          name: 'Renamed',
          lead: null,
          labels: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } }
        })
      }
    })
    const { changedLinearProjectFields } = await import('./project-field-edits')
    const { getProjectByIdForAgent } = await import('./project-create')

    const previous = await getProjectByIdForAgent('project-1', 'workspace-1')
    const current = await getProjectByIdForAgent('project-1', 'workspace-1')

    expect(
      previous &&
        current &&
        changedLinearProjectFields(
          { name: 'Renamed', leadId: null, labelIds: [], priority: 3 },
          previous.fields,
          current.fields
        )
    ).toEqual(['name', 'lead', 'labels'])
  })
})

import { describe, expect, it } from 'vitest'
import type { ShortcutWorkspace } from '../../shared/shortcut-types'
import { mapComment, mapStory } from './story-mapping'
import { getShortcutWorkspaceId, toShortcutWorkspace } from './workspace-identity'
import type { ShortcutWorkspaceMetadata } from './workspace-metadata'

const WORKSPACE: ShortcutWorkspace = {
  id: 'ws-1',
  urlSlug: 'acme',
  name: 'Acme',
  memberId: 'member-uuid-1',
  memberName: 'Ada',
  mentionName: 'ada'
}

function metadataFixture(): ShortcutWorkspaceMetadata {
  const state = { id: '101', name: 'In Progress', type: 'started' as const, position: 1 }
  return {
    workflows: [{ id: '7', name: 'Engineering', defaultStateId: '100', states: [state] }],
    statesById: new Map([['101', { state, workflowId: '7', workflowName: 'Engineering' }]]),
    membersById: new Map([
      ['member-uuid-1', { id: 'member-uuid-1', name: 'Ada Lovelace', mentionName: 'ada' }]
    ]),
    activeMembers: [{ id: 'member-uuid-1', name: 'Ada Lovelace', mentionName: 'ada' }],
    teamsById: new Map([['group-uuid-1', { id: 'group-uuid-1', name: 'Core' }]])
  }
}

describe('mapStory', () => {
  it('denormalizes state, team, and owners from workspace metadata', () => {
    const story = mapStory(WORKSPACE, metadataFixture(), {
      id: 42,
      name: 'Fix login',
      app_url: 'https://app.shortcut.com/acme/story/42/fix-login',
      story_type: 'bug',
      workflow_state_id: 101,
      group_id: 'group-uuid-1',
      owner_ids: ['member-uuid-1'],
      requested_by_id: 'member-uuid-1',
      labels: [{ name: 'auth' }, { name: '' }],
      archived: false,
      completed: false,
      started: true,
      estimate: 2,
      updated_at: '2026-08-20T10:00:00Z',
      created_at: '2026-08-01T10:00:00Z'
    })

    expect(story).toMatchObject({
      id: '42',
      workspaceId: 'ws-1',
      workspaceName: 'Acme',
      title: 'Fix login',
      url: 'https://app.shortcut.com/acme/story/42/fix-login',
      storyType: 'bug',
      state: { id: '101', name: 'In Progress', type: 'started' },
      workflowId: '7',
      team: expect.objectContaining({ id: 'group-uuid-1', name: 'Core' }),
      labels: ['auth'],
      owners: [expect.objectContaining({ name: 'Ada Lovelace' })],
      requester: expect.objectContaining({ name: 'Ada Lovelace' }),
      estimate: 2,
      updatedAt: '2026-08-20T10:00:00Z',
      createdAt: '2026-08-01T10:00:00Z'
    })
  })

  it('degrades safely when metadata cannot resolve the referenced ids', () => {
    const story = mapStory(WORKSPACE, metadataFixture(), {
      id: 7,
      name: 'Orphan',
      story_type: 'chore',
      workflow_state_id: 999,
      owner_ids: ['member-unknown'],
      completed: true,
      created_at: '2026-08-01T10:00:00Z'
    })

    expect(story.state).toEqual({ id: '999', name: 'Unknown', type: 'done' })
    expect(story.owners).toEqual([{ id: 'member-unknown', name: 'Unknown' }])
    expect(story.team).toBeUndefined()
    // No app_url in the payload: fall back to the canonical web URL.
    expect(story.url).toBe('https://app.shortcut.com/acme/story/7')
  })
})

describe('mapComment', () => {
  it('maps text comments and resolves the author', () => {
    const comment = mapComment(metadataFixture(), {
      id: 9,
      text: 'Ship it',
      author_id: 'member-uuid-1',
      created_at: '2026-08-21T10:00:00Z',
      updated_at: '2026-08-22T10:00:00Z',
      deleted: false
    })
    expect(comment).toMatchObject({
      id: '9',
      body: 'Ship it',
      createdAt: '2026-08-21T10:00:00Z',
      updatedAt: '2026-08-22T10:00:00Z',
      author: expect.objectContaining({ name: 'Ada Lovelace' })
    })
  })

  it('drops deleted and text-less comments', () => {
    expect(
      mapComment(metadataFixture(), { id: 9, text: 'gone', deleted: true, created_at: 'x' })
    ).toBeNull()
    expect(mapComment(metadataFixture(), { id: 9, text: null, created_at: 'x' })).toBeNull()
  })
})

describe('workspace identity', () => {
  it('derives a stable id from slug and member and parses /member payloads', () => {
    const workspace = toShortcutWorkspace({
      id: 'member-uuid-1',
      mention_name: 'ada',
      name: 'Ada',
      workspace2: { url_slug: 'acme', name: 'Acme' }
    })
    expect(workspace).toMatchObject({
      urlSlug: 'acme',
      name: 'Acme',
      memberId: 'member-uuid-1',
      memberName: 'Ada',
      mentionName: 'ada'
    })
    expect(workspace?.id).toBe(getShortcutWorkspaceId('acme', 'member-uuid-1'))
    expect(getShortcutWorkspaceId('acme', 'member-uuid-1')).toBe(
      getShortcutWorkspaceId('acme', 'MEMBER-UUID-1')
    )
    expect(getShortcutWorkspaceId('acme', 'member-uuid-1')).not.toBe(
      getShortcutWorkspaceId('acme', 'member-uuid-2')
    )
  })

  it('rejects payloads without a member id or workspace slug', () => {
    expect(toShortcutWorkspace({ id: 'member-uuid-1' })).toBeNull()
    expect(toShortcutWorkspace({ workspace2: { url_slug: 'acme' } })).toBeNull()
  })
})

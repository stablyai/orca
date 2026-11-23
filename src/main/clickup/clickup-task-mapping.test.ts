import { expect, it } from 'vitest'
import {
  mapClickUpComments,
  mapClickUpTask,
  mapClickUpWorkspaces
} from './clickup-response-mapping'
import { parseClickUpSearchIntent, parseClickUpTaskReference } from './clickup-task-search-query'

it('maps a full task payload with millisecond strings and a hidden folder', () => {
  const task = mapClickUpTask(
    {
      id: '86abc12de',
      custom_id: 'ENG-7',
      name: 'Fix login',
      markdown_description: '## Steps',
      description: 'ignored when markdown is present',
      status: { status: 'in progress', color: '#4194f6', type: 'custom', orderindex: 2 },
      priority: { id: '2', priority: 'high', color: '#ffcc00' },
      assignees: [
        { id: 183, username: 'ada', email: 'ada@example.com', profilePicture: 'https://x/a.png' }
      ],
      creator: { id: 9, username: 'bob', email: 'bob@example.com' },
      tags: [{ name: 'bug' }, { name: 'p1' }],
      url: 'https://app.clickup.com/t/86abc12de',
      date_created: '1700000000000',
      date_updated: '1700000100000',
      due_date: '1700000200000',
      list: { id: '55', name: 'Sprint' },
      folder: { id: 'hidden', name: 'hidden', hidden: true },
      space: { id: '77' },
      team_id: '9001',
      parent: '86parent1'
    },
    'fallback'
  )
  expect(task).toEqual({
    id: '86abc12de',
    customId: 'ENG-7',
    name: 'Fix login',
    descriptionMarkdown: '## Steps',
    status: { name: 'in progress', color: '#4194f6', type: 'custom', orderIndex: 2 },
    priority: { id: '2', label: 'high', color: '#ffcc00' },
    assignees: [
      { id: '183', username: 'ada', email: 'ada@example.com', avatarUrl: 'https://x/a.png' }
    ],
    creator: { id: '9', username: 'bob', email: 'bob@example.com' },
    tags: ['bug', 'p1'],
    url: 'https://app.clickup.com/t/86abc12de',
    createdAt: '2023-11-14T22:13:20.000Z',
    updatedAt: '2023-11-14T22:15:00.000Z',
    dueAt: '2023-11-14T22:16:40.000Z',
    list: { id: '55', name: 'Sprint' },
    folder: null,
    spaceId: '77',
    workspaceId: '9001',
    parentId: '86parent1'
  })
})

it('survives missing, null and wrongly typed fields', () => {
  const task = mapClickUpTask(
    {
      id: 42,
      name: null,
      status: 'open',
      priority: { id: null },
      assignees: 'nobody',
      tags: [null, { name: 3 }],
      date_created: 'not-a-date',
      due_date: null,
      list: null,
      folder: { id: '8', name: 'Roadmap' }
    },
    'fallback'
  )
  expect(task).toMatchObject({
    id: '42',
    customId: null,
    name: '',
    descriptionMarkdown: '',
    status: { name: '', type: 'custom', orderIndex: 0 },
    priority: null,
    assignees: [],
    tags: [],
    url: 'https://app.clickup.com/t/42',
    createdAt: '1970-01-01T00:00:00.000Z',
    updatedAt: '1970-01-01T00:00:00.000Z',
    dueAt: null,
    list: { id: '', name: '' },
    folder: { id: '8', name: 'Roadmap' },
    workspaceId: 'fallback',
    parentId: null
  })
  expect(mapClickUpTask({ name: 'no id' }, 'fallback')).toBeNull()
  expect(mapClickUpTask('garbage', 'fallback')).toBeNull()
})

it('maps workspaces and comments, dropping entries without ids', () => {
  expect(
    mapClickUpWorkspaces({ teams: [{ id: '1', name: 'Acme', color: '#fff' }, { id: '2' }, null] })
  ).toEqual([{ id: '1', name: 'Acme', color: '#fff' }])
  expect(
    mapClickUpComments({
      comments: [
        { id: 458, comment_text: 'hello', date: '1700000000000', user: { id: 1, username: 'ada' } },
        { id: '459', comment: [{ text: 'rich ' }, { text: 'text' }], date: 'x' },
        { comment_text: 'no id' }
      ]
    })
  ).toEqual([
    {
      id: '458',
      body: 'hello',
      createdAt: '2023-11-14T22:13:20.000Z',
      author: { id: '1', username: 'ada', email: '' }
    },
    { id: '459', body: 'rich text', createdAt: '1970-01-01T00:00:00.000Z', author: null }
  ])
})

it('parses task urls, raw ids and custom ids', () => {
  expect(parseClickUpTaskReference('https://app.clickup.com/t/86abc12de')).toEqual({
    kind: 'id',
    id: '86abc12de'
  })
  expect(parseClickUpTaskReference('https://app.clickup.com/t/86abc12de?comment=1')).toEqual({
    kind: 'id',
    id: '86abc12de'
  })
  expect(parseClickUpTaskReference('https://app.clickup.com/t/9001/eng-7')).toEqual({
    kind: 'custom-id',
    customId: 'ENG-7',
    workspaceId: '9001'
  })
  expect(parseClickUpTaskReference('ENG-123')).toEqual({
    kind: 'custom-id',
    customId: 'ENG-123',
    workspaceId: null
  })
  expect(parseClickUpTaskReference('  86abc12de ')).toEqual({ kind: 'id', id: '86abc12de' })
})

it('rejects foreign hosts and non-task paths', () => {
  expect(parseClickUpTaskReference('https://evil.example/t/86abc12de')).toBeNull()
  expect(parseClickUpTaskReference('https://notclickup.com/t/86abc12de')).toBeNull()
  expect(parseClickUpTaskReference('https://app.clickup.com/9001/v/l/6-1-1')).toBeNull()
  expect(parseClickUpTaskReference('login bug')).toBeNull()
  expect(parseClickUpTaskReference('')).toBeNull()
})

it('flags whether a reference came from a url so a bare word can still be text-searched', () => {
  expect(parseClickUpSearchIntent('https://app.clickup.com/t/86abc12de')).toMatchObject({
    kind: 'reference',
    fromUrl: true
  })
  expect(parseClickUpSearchIntent('deployed')).toMatchObject({
    kind: 'reference',
    fromUrl: false
  })
  expect(parseClickUpSearchIntent(' fix the login ')).toEqual({
    kind: 'text',
    text: 'fix the login'
  })
})

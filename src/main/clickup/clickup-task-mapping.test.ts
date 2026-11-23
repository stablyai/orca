import { expect, it } from 'vitest'
import {
  mapClickUpComments,
  mapClickUpTask,
  mapClickUpTaskPage,
  mapClickUpWorkspaces
} from './clickup-response-mapping'
import { parseClickUpSearchIntent } from './clickup-task-search-query'

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

it('drops done and closed tasks from an open list yet keeps paging while ClickUp has pages', () => {
  const task = (id: string, type: string) => ({ id, name: id, status: { status: id, type } })
  const payload = {
    tasks: [task('1', 'done'), task('2', 'closed'), task('3', 'custom')],
    last_page: false
  }
  const open = mapClickUpTaskPage(payload, 'w', 4, false)
  expect(open.tasks.map((entry) => entry.id)).toEqual(['3'])
  expect(open.nextPage).toBe(5)

  const allDone = mapClickUpTaskPage(
    { ...payload, tasks: payload.tasks.slice(0, 2) },
    'w',
    4,
    false
  )
  expect(allDone).toEqual({ tasks: [], nextPage: 5 })

  expect(mapClickUpTaskPage(payload, 'w', 4, true).tasks).toHaveLength(3)
  expect(mapClickUpTaskPage({ ...payload, last_page: true }, 'w', 4, false).nextPage).toBeNull()
})

it.each([
  ['https://app.clickup.com/t/abc', 'https://app.clickup.com/t/abc'],
  ['https://clickup.com/t/abc', 'https://clickup.com/t/abc'],
  ['https://evil.example/t/abc', 'https://app.clickup.com/t/abc'],
  ['https://clickup.com.evil.example/t/abc', 'https://app.clickup.com/t/abc'],
  ['https://notclickup.com/t/abc', 'https://app.clickup.com/t/abc'],
  ['http://app.clickup.com/t/abc', 'https://app.clickup.com/t/abc'],
  ['javascript:alert(1)', 'https://app.clickup.com/t/abc'],
  ['https://user:pw@app.clickup.com/t/abc', 'https://app.clickup.com/t/abc'],
  ['not a url', 'https://app.clickup.com/t/abc']
])('trusts the task url %s only on https clickup.com hosts', (url, expected) => {
  expect(mapClickUpTask({ id: 'abc', url }, 'w')?.url).toBe(expected)
})

it('offers no next page past the page limit', () => {
  const payload = { tasks: [{ id: 'a' }], last_page: false }
  expect(mapClickUpTaskPage(payload, 'w', 999, true).nextPage).toBe(1000)
  expect(mapClickUpTaskPage(payload, 'w', 1000, true).nextPage).toBeNull()
})

import { expect, it } from 'vitest'
import { makeTestBotItem } from '../../shared/bots/bot-item.test-fixture'
import { botItemJsonView, botItemStatusFromCli } from './bot-item-cli-status'

const OWNER = { kind: 'owner' } as const

it('takes in-progress (and its --json name) for In progress, never working', () => {
  expect(botItemStatusFromCli('in-progress')).toBe('working')
  expect(botItemStatusFromCli('in_progress')).toBe('working')
  expect(botItemStatusFromCli('needs-you')).toBe('needs_you')
  expect(botItemStatusFromCli('working')).toBeNull()
})

it('reports In progress as in_progress in --json: items, counts and status events', () => {
  const view = botItemJsonView({
    item: makeTestBotItem(3),
    counts: { working: 2, needs_you: 1 },
    events: [
      { id: 'e1', kind: 'made', actor: OWNER, data: { status: 'working' }, at: 1 },
      { id: 'e2', kind: 'status', actor: OWNER, data: { from: 'working', to: 'needs_you' }, at: 2 }
    ]
  })

  expect(view).toMatchObject({
    item: { status: 'in_progress' },
    counts: { in_progress: 2, needs_you: 1 },
    events: [
      { data: { status: 'in_progress' } },
      { data: { from: 'in_progress', to: 'needs_you' } }
    ]
  })
  expect(JSON.stringify(view)).not.toContain('"working"')
})

import { describe, expect, it, vi } from 'vitest'
import type { Automation } from '../../shared/automations/automation-definition'
import type { ConnectorRefResolver } from '../connector-cloud/connector-ref-resolution'
import {
  botPlaceMigrationOnHello,
  migrateBotAutomationPlaces
} from './bot-automation-ref-migration'

const REFS: Record<string, { ref: string; label: string; key?: string }> = {
  'place:C0ENG': { ref: 'slack:T1:C0ENG', label: '#eng' },
  'place:ENG': { ref: 'linear:org-1:team:t1', label: 'ENG Engineering' },
  'subject:ENG-7': { ref: 'linear:org-1:issue-7', label: 'ENG-7 Flaky login', key: 'ENG-7' },
  'subject:acme/web#8': { ref: 'github:42:777:8', label: 'acme/web#8' }
}

const resolver = () =>
  vi.fn<ConnectorRefResolver>(async (_bot, _source, role, input) => {
    const found = REFS[`${role}:${input}`]
    if (!found) {
      throw new Error('no match')
    }
    return found
  })

type Row = Pick<Automation, 'id' | 'on' | 'bot'>
// Only the fields the pass reads.
const automation = (fields: Row): Row => fields

function host(rows: Row[]) {
  const updates: { id: string; patch: unknown }[] = []
  return {
    updates,
    list: () => rows,
    update: async (
      id: string,
      patch: Pick<Automation, 'on' | 'bot'>,
      unchangedSince: Pick<Automation, 'on' | 'bot'>
    ) => {
      updates.push({ id, patch })
      expect(unchangedSince).toEqual({
        on: rows.find((entry) => entry.id === id)?.on,
        bot: rows.find((entry) => entry.id === id)?.bot
      })
      const row = rows.find((entry) => entry.id === id)
      Object.assign(row ?? {}, patch)
    }
  }
}

const slackBot = { botId: 'bot-1', runsIn: 'new' as const, resultsTo: { linearIssue: 'ENG-7' } }

describe('migrateBotAutomationPlaces', () => {
  it('rewrites names as refs, keeping each rule id, webhook rules, and what the cloud cannot place', async () => {
    const hook = { id: 'hook-1', source: 'webhook' as const, event: 'call' as const, rev: 1 }
    const rows = [
      automation({
        id: 'auto-1',
        bot: slackBot,
        on: [
          {
            id: 'on-1',
            source: 'slack',
            event: 'mentioned',
            in: ['C0ENG', 'C0GONE'],
            subject: 'T1:C0ENG:1.2'
          },
          { id: 'on-2', source: 'github', event: 'pr_opened', subject: 'acme/web#8' },
          hook
        ]
      }),
      automation({
        id: 'auto-2',
        on: [{ id: 'on-3', source: 'linear', event: 'assigned', in: ['ENG'] }]
      })
    ]
    const store = host(rows)
    await expect(migrateBotAutomationPlaces(store, resolver())).resolves.toBe(1)
    expect(store.updates).toEqual([
      {
        id: 'auto-1',
        patch: {
          on: [
            // The Slack thread written before refs stays, still matched by name.
            {
              id: 'on-1',
              source: 'slack',
              event: 'mentioned',
              in: ['C0GONE', 'slack:T1:C0ENG'],
              subject: 'T1:C0ENG:1.2',
              names: { 'slack:T1:C0ENG': '#eng' }
            },
            {
              id: 'on-2',
              source: 'github',
              event: 'pr_opened',
              subject: 'github:42:777:8',
              names: { 'github:42:777:8': 'acme/web#8' }
            },
            hook
          ],
          bot: {
            ...slackBot,
            // The key older clients read stays; the ref rides beside it.
            resultsTo: {
              linearIssue: 'ENG-7',
              ref: 'linear:org-1:issue-7',
              label: 'ENG-7 Flaky login'
            }
          }
        }
      }
    ])
  })

  it('changes nothing on a second pass', async () => {
    const rows = [
      automation({
        id: 'auto-1',
        bot: slackBot,
        on: [{ id: 'on-1', source: 'linear', event: 'assigned', in: ['ENG'], subject: 'ENG-7' }]
      })
    ]
    const store = host(rows)
    const resolve = resolver()
    await migrateBotAutomationPlaces(store, resolve)
    await expect(migrateBotAutomationPlaces(store, resolve)).resolves.toBe(0)
    expect(store.updates).toHaveLength(1)
    expect(rows[0]?.on).toEqual([
      {
        id: 'on-1',
        source: 'linear',
        event: 'assigned',
        in: ['linear:org-1:team:t1'],
        subject: 'linear:org-1:issue-7',
        names: {
          'linear:org-1:team:t1': 'ENG Engineering',
          'linear:org-1:issue-7': 'ENG-7 Flaky login'
        }
      }
    ])
  })

  it('leaves an automation edited while it waited on the cloud for the next launch', async () => {
    const rows = [
      automation({
        id: 'auto-1',
        bot: slackBot,
        on: [{ id: 'on-1', source: 'linear', event: 'assigned', in: ['ENG'] }]
      })
    ]
    const store = host(rows)
    const edited = {
      id: 'on-1',
      source: 'linear' as const,
      event: 'assigned' as const,
      in: ['OPS']
    }
    const resolve = vi.fn<ConnectorRefResolver>(async (_bot, _source, role, input) => {
      // Someone edits the rule while the pass waits on its lookup.
      rows[0] = { ...rows[0]!, on: [edited] }
      return REFS[`${role}:${input}`] ?? { ref: input, label: input }
    })
    await expect(migrateBotAutomationPlaces(store, resolve)).resolves.toBe(0)
    expect(store.updates).toEqual([])
    expect(rows[0]?.on).toEqual([edited])
  })

  it('runs once a launch, and only once the cloud takes refs', async () => {
    const store = host([automation({ id: 'auto-1', bot: slackBot })])
    let resolve: ConnectorRefResolver | null = null
    const onHello = botPlaceMigrationOnHello(store, () => resolve)
    onHello()
    resolve = resolver()
    onHello()
    onHello()
    await vi.waitFor(() => expect(store.updates).toHaveLength(1))
  })
})

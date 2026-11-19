import { describe, expect, it, vi } from 'vitest'
import type { AutomationEventTrigger } from '../../shared/automation-event-triggers'
import type { BotsCloudClient } from '../connector-cloud/bots-cloud-client'
import {
  assertGitHub2Triggers,
  assertOwnTriggers,
  assertWorkflowTriggers,
  cloudTriggerPeopleSearch,
  GITHUB2_TRIGGERS_UNSUPPORTED,
  OWN_TRIGGERS_UNSUPPORTED,
  TRIGGER_PEOPLE_UNSUPPORTED,
  WORKFLOW_TRIGGERS_UNSUPPORTED,
  withTriggerPeople,
  type TriggerPeopleSearch
} from './bot-trigger-people'

const PEOPLE = [
  { id: 'U0DANA', name: 'Dana' },
  { id: 'U0DAN', name: 'Dan' },
  { id: 'U0SAM', name: 'Sam' }
]
const search = vi.fn<TriggerPeopleSearch>(async (_source, query) =>
  PEOPLE.filter((person) => person.name.toLowerCase().startsWith(query.toLowerCase()))
)
const rule = (
  fields: Partial<Extract<AutomationEventTrigger, { source: 'slack' }>>
): AutomationEventTrigger => ({
  id: 'on-1',
  source: 'slack',
  event: 'mentioned',
  ...fields
})

describe('withTriggerPeople', () => {
  it('looks each @name up as one person exactly, and keeps ids', async () => {
    await expect(
      withTriggerPeople(search, [rule({ from: ['@sam', 'Dana', 'U0OTHER'] })])
    ).resolves.toEqual([
      rule({ from: ['U0DANA', 'U0OTHER', 'U0SAM'], names: { U0DANA: 'Dana', U0SAM: 'Sam' } })
    ])
  })

  it("keeps a saved person's name, and the places' names beside it", async () => {
    const saved = [rule({ from: ['U0DANA'], names: { U0DANA: 'Dana' } })]
    await expect(
      withTriggerPeople(
        search,
        [rule({ in: ['slack:T1:C1'], from: ['U0DANA', 'Sam'], names: { 'slack:T1:C1': '#eng' } })],
        saved
      )
    ).resolves.toEqual([
      rule({
        in: ['slack:T1:C1'],
        from: ['U0DANA', 'U0SAM'],
        names: { 'slack:T1:C1': '#eng', U0DANA: 'Dana', U0SAM: 'Sam' }
      })
    ])
  })

  it('refuses a name that names no one, or no one exactly, with who it could be', async () => {
    await expect(withTriggerPeople(search, [rule({ from: ['@Da'] })])).rejects.toThrow(
      /U0DANA \(Dana\), U0DAN \(Dan\)/
    )
    await expect(withTriggerPeople(search, [rule({ from: ['@zoe'] })])).rejects.toThrow(
      /No one.*"@zoe"/
    )
  })

  it("refuses from= and on=mine where Orca Cloud doesn't take them, but keeps saved ones", async () => {
    await expect(withTriggerPeople(null, [rule({ from: ['U0DANA'] })])).rejects.toThrow(
      TRIGGER_PEOPLE_UNSUPPORTED
    )
    await expect(
      withTriggerPeople(null, [rule({ event: 'reaction', onOwnerMessage: true })])
    ).rejects.toThrow(TRIGGER_PEOPLE_UNSUPPORTED)
    const saved = [
      rule({ from: ['U0DANA'] }),
      rule({ id: 'on-2', event: 'reaction', onOwnerMessage: true })
    ]
    await expect(withTriggerPeople(null, saved, saved)).resolves.toEqual(saved)
  })
})

describe('cloudTriggerPeopleSearch', () => {
  it('looks in every workspace the bot is in, so one name in two is two people', async () => {
    const slackMembers = vi.fn(async (_botId: string, _query: string, teamId?: string) =>
      teamId === 'T2'
        ? { ok: false as const, error: 'cloud_unreachable' }
        : {
            ok: true as const,
            value: { members: [{ id: `U0DANA${teamId}`, name: 'Dana' }], complete: true }
          }
    )
    const linearMembers = vi.fn(async (workspaceId: string) => ({
      ok: true as const,
      value: { members: [{ id: `dana-${workspaceId}`, name: 'Dana' }] }
    }))
    const client = { slackMembers, linearMembers, githubUsers: vi.fn() }
    const bot = {
      id: 'b1',
      slack: { appId: 'A1', teamId: 'T1' },
      slackApps: [
        { appId: 'A1', teamId: 'T1' },
        { appId: 'A2', teamId: 'T2' },
        { appId: 'A3', teamId: 'T3' }
      ],
      linear: { workspaceId: 'w1', workspaceName: 'One' },
      linearWorkspaces: [
        { workspaceId: 'w1', workspaceName: 'One' },
        { workspaceId: 'w2', workspaceName: 'Two' }
      ]
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the search calls only the three lookups stubbed here.
    const cloud = client as unknown as BotsCloudClient
    const people = cloudTriggerPeopleSearch(cloud, bot)
    // One workspace that can't say leaves the others' answers.
    expect(await people('slack', 'Dana')).toEqual([
      { id: 'U0DANAT1', name: 'Dana' },
      { id: 'U0DANAT3', name: 'Dana' }
    ])
    expect(await people('linear', 'Dana')).toEqual([
      { id: 'dana-w1', name: 'Dana' },
      { id: 'dana-w2', name: 'Dana' }
    ])
    await expect(withTriggerPeople(people, [rule({ from: ['Dana'] })])).rejects.toThrow(
      'names no one person exactly'
    )
    const unlinked = { id: 'b2', slack: null, linear: null }
    expect(await cloudTriggerPeopleSearch(cloud, unlinked)('slack', 'Dana')).toBeNull()
  })
})

describe('assertGitHub2Triggers', () => {
  const green: AutomationEventTrigger = {
    id: 'on-green',
    source: 'github',
    event: 'ci_passed',
    subject: 'acme/web#4'
  }
  const label: AutomationEventTrigger = { id: 'on-l', source: 'github', event: 'labeled' }

  it("refuses a new rule on an event this cloud doesn't send, and keeps a saved one", () => {
    expect(() => assertGitHub2Triggers(false, [green])).toThrow(GITHUB2_TRIGGERS_UNSUPPORTED)
    expect(() => assertGitHub2Triggers(false, [label])).toThrow(GITHUB2_TRIGGERS_UNSUPPORTED)
    expect(() => assertGitHub2Triggers(true, [green, label])).not.toThrow()
    expect(() => assertGitHub2Triggers(false, [green], [green])).not.toThrow()
  })
})

describe('assertWorkflowTriggers', () => {
  const run: AutomationEventTrigger = {
    id: 'on-run',
    source: 'github',
    event: 'workflow_finished',
    in: ['github:42:500'],
    run: '9001'
  }

  it("refuses a new wait on a run this cloud doesn't send, and keeps a saved one", () => {
    expect(() => assertWorkflowTriggers(false, [run])).toThrow(WORKFLOW_TRIGGERS_UNSUPPORTED)
    expect(() => assertWorkflowTriggers(true, [run])).not.toThrow()
    expect(() => assertWorkflowTriggers(false, [run], [run])).not.toThrow()
  })
})

describe('assertOwnTriggers', () => {
  const own: AutomationEventTrigger = {
    id: 'on-own',
    source: 'github',
    event: 'pr_opened',
    fromOwner: true
  }

  it('refuses a new from=me rule where Orca Cloud would drop it, and keeps a saved one', () => {
    expect(() => assertOwnTriggers(false, [own])).toThrow(OWN_TRIGGERS_UNSUPPORTED)
    expect(() => assertOwnTriggers(true, [own])).not.toThrow()
    expect(() => assertOwnTriggers(false, [own], [own])).not.toThrow()
  })
})

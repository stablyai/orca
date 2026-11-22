import { describe, expect, it, vi } from 'vitest'
import type { AutomationEventTrigger } from '../../shared/automation-event-triggers'
import {
  ConnectorRefNotFoundError,
  type ConnectorRefResolver
} from '../connector-cloud/connector-ref-resolution'
import { LINEAR_ISSUE_KEY_PATTERN } from '../../shared/connector-bot-linear-contract'
import { withPlaceRefs } from './bot-automation-place-refs'

const REFS: Record<string, { ref: string; label: string; key?: string }> = {
  'place:#eng': { ref: 'slack:T1:C1', label: '#eng' },
  'place:C0OLD': { ref: 'slack:T1:C0OLD', label: '#old' },
  'place:acme/web': { ref: 'github:42:777', label: 'acme/web' },
  'subject:acme/web#8': { ref: 'github:42:777:8', label: 'acme/web#8' },
  'subject:ENG-7': { ref: 'linear:org-1:issue-7', label: 'ENG-7 Flaky login', key: 'ENG-7' }
}

function cloud(): ConnectorRefResolver & ReturnType<typeof vi.fn> {
  return vi.fn<ConnectorRefResolver>(async (_bot, _source, role, input) => {
    const found = REFS[`${role}:${input}`]
    if (!found) {
      throw new Error(`Nothing matches "${input}".`)
    }
    return found
  })
}

const rule = (
  fields: Partial<Extract<AutomationEventTrigger, { source: 'slack' }>>
): AutomationEventTrigger => ({
  id: 'on-1',
  source: 'slack',
  event: 'mentioned',
  ...fields
})

describe('withPlaceRefs', () => {
  it("names each rule's places, its subject and where results post as refs, with a label for people", async () => {
    const placed = await withPlaceRefs(cloud(), 'bot-1', {
      on: [
        rule({ in: ['#eng', 'C0OLD'] }),
        {
          id: 'on-2',
          source: 'github',
          event: 'pr_opened',
          in: ['acme/web'],
          subject: 'acme/web#8'
        }
      ],
      resultsTo: { linearIssue: 'ENG-7' }
    })
    expect(placed).toEqual({
      on: [
        rule({
          in: ['slack:T1:C0OLD', 'slack:T1:C1'],
          names: { 'slack:T1:C0OLD': '#old', 'slack:T1:C1': '#eng' }
        }),
        {
          id: 'on-2',
          source: 'github',
          event: 'pr_opened',
          in: ['github:42:777'],
          subject: 'github:42:777:8',
          names: { 'github:42:777': 'acme/web', 'github:42:777:8': 'acme/web#8' }
        }
      ],
      resultsTo: { linearIssue: 'ENG-7', ref: 'linear:org-1:issue-7', label: 'ENG-7 Flaky login' }
    })
  })

  it('looks up only what changed: a saved place or result stays as it is, with its name', async () => {
    const resolve = cloud()
    const saved = {
      on: [rule({ in: ['slack:T1:C1'], names: { 'slack:T1:C1': '#eng' } })],
      resultsTo: { channel: 'C0SAVED' }
    }
    const placed = await withPlaceRefs(
      resolve,
      'bot-1',
      { on: [rule({ in: ['slack:T1:C1'] })], resultsTo: { channel: 'C0SAVED' } },
      saved
    )
    expect(placed.on).toEqual(saved.on)
    expect(placed.resultsTo).toBe(saved.resultsTo)
    expect(resolve).not.toHaveBeenCalled()
  })

  it('looks a saved place up for its name only when it was saved before names', async () => {
    const resolve = vi.fn<ConnectorRefResolver>(async (_bot, _source, _role, input) =>
      input === 'slack:T1:C1' ? { ref: input, label: '#eng' } : Promise.reject(new Error('gone'))
    )
    const saved = { on: [rule({ in: ['slack:T1:C1', 'slack:T1:C9'] })] }
    const placed = await withPlaceRefs(resolve, 'bot-1', saved, saved)
    // A place the cloud can't name now stays, unnamed, rather than failing the save.
    expect(placed.on).toEqual([
      rule({ in: ['slack:T1:C1', 'slack:T1:C9'], names: { 'slack:T1:C1': '#eng' } })
    ])
  })

  it('keeps no name that is only the ref or a bare channel id', async () => {
    const resolve = vi.fn<ConnectorRefResolver>(async (_bot, _source, _role, input) => ({
      ref: input === 'C0BARE' ? 'slack:T1:C0BARE' : 'slack:T1:C2:1.2',
      label: input === 'C0BARE' ? 'C0BARE' : 'slack:T1:C2:1.2'
    }))
    const placed = await withPlaceRefs(resolve, 'bot-1', {
      on: [rule({ in: ['C0BARE'], subject: 'slack:T1:C2:1.2' })]
    })
    expect(placed.on).toEqual([rule({ in: ['slack:T1:C0BARE'], subject: 'slack:T1:C2:1.2' })])
  })

  it("keeps an id or key where the cloud takes no refs, or can't say yet, and refuses a name", async () => {
    const older = await withPlaceRefs(null, 'bot-1', {
      on: [rule({ in: ['c0abc'] })],
      resultsTo: { channel: 'https://acme.slack.com/archives/C0RES' }
    })
    expect(older).toEqual({ on: [rule({ in: ['C0ABC'] })], resultsTo: { channel: 'C0RES' } })
    await expect(withPlaceRefs(null, 'bot-1', { on: [rule({ in: ['#eng'] })] })).rejects.toThrow(
      'in= takes Slack channel ids (C0123ABCD) or pasted channel links, not "#eng": this computer\'s Orca Cloud can\'t look up names and links yet.'
    )
    await expect(
      withPlaceRefs(null, 'bot-1', { resultsTo: { linearIssue: 'linear:org-1:issue-7' } })
    ).rejects.toThrow('Results go to a Linear issue by its key (ENG-123)')
    // A bot the cloud doesn't list yet: its ids still match by name, a name is refused in the cloud's words.
    const unlisted = vi.fn<ConnectorRefResolver>(async () => {
      throw new Error("This bot isn't on Orca Cloud yet.")
    })
    await expect(
      withPlaceRefs(unlisted, 'bot-1', { on: [rule({ in: ['C0ABC'] })] })
    ).resolves.toEqual({
      on: [rule({ in: ['C0ABC'] })]
    })
    await expect(
      withPlaceRefs(unlisted, 'bot-1', { on: [rule({ in: ['#eng'] })] })
    ).rejects.toThrow("This bot isn't on Orca Cloud yet.")
  })

  it('refuses a new subject the cloud found unreachable, keeps it when the cloud gave no answer or it was saved', async () => {
    const wait = (subject: string): AutomationEventTrigger => ({
      id: 'on-1',
      source: 'github',
      event: 'ci_passed',
      subject
    })
    const unreachable = vi.fn<ConnectorRefResolver>(async () => {
      throw new ConnectorRefNotFoundError(
        "acme/infra isn't among the repositories the Orca GitHub app can reach"
      )
    })
    await expect(
      withPlaceRefs(unreachable, 'bot-1', { on: [wait('acme/infra#871')] })
    ).rejects.toThrow("acme/infra isn't among the repositories the Orca GitHub app can reach")
    const offline = vi.fn<ConnectorRefResolver>(async () => {
      throw new Error('Orca Cloud couldn\'t look up "acme/infra#871" (offline).')
    })
    await expect(
      withPlaceRefs(offline, 'bot-1', { on: [wait('acme/infra#871')] })
    ).resolves.toEqual({ on: [wait('acme/infra#871')] })
    const saved = { on: [wait('acme/infra#871')] }
    await expect(withPlaceRefs(unreachable, 'bot-1', saved, saved)).resolves.toEqual(saved)
  })

  it("keeps the key an older client's own check takes, and the ref when it saves back only the key", async () => {
    const saved = { linearIssue: 'ENG-7', ref: 'linear:org-1:issue-7', label: 'ENG-7 Flaky login' }
    // The check an older editor runs before it saves.
    expect(LINEAR_ISSUE_KEY_PATTERN.test(saved.linearIssue)).toBe(true)
    const resolve = cloud()
    const placed = await withPlaceRefs(
      resolve,
      'bot-1',
      { resultsTo: { linearIssue: 'ENG-7' } },
      { resultsTo: saved }
    )
    expect(placed.resultsTo).toBe(saved)
    // Without the cloud too.
    await expect(
      withPlaceRefs(null, 'bot-1', { resultsTo: { linearIssue: 'ENG-7' } }, { resultsTo: saved })
    ).resolves.toEqual({ resultsTo: saved })
    expect(resolve).not.toHaveBeenCalled()
  })

  it("looks a finished run's repo up as a ref, never keeping its name", async () => {
    const waiting: AutomationEventTrigger = {
      id: 'on-run',
      source: 'github',
      event: 'workflow_finished',
      in: ['acme/web'],
      run: '9001'
    }
    const placed = await withPlaceRefs(cloud(), 'bot-1', { on: [waiting] })
    expect(placed.on).toEqual([
      { ...waiting, in: ['github:42:777'], names: { 'github:42:777': 'acme/web' } }
    ])
    // Even where another rule saved the name, and where no cloud can look it up.
    const saved = {
      on: [{ id: 'on-c', source: 'github' as const, event: 'comment' as const, in: ['acme/web'] }]
    }
    expect((await withPlaceRefs(cloud(), 'bot-1', { on: [waiting] }, saved)).on?.[0]).toMatchObject(
      {
        in: ['github:42:777']
      }
    )
    await expect(withPlaceRefs(null, 'bot-1', { on: [waiting] })).rejects.toThrow(
      "github.workflow_finished needs this computer's Orca Cloud to look up the run's repo"
    )
    const failing = vi.fn<ConnectorRefResolver>(async () => {
      throw new Error('Orca Cloud is unreachable.')
    })
    await expect(withPlaceRefs(failing, 'bot-1', { on: [waiting] })).rejects.toThrow(
      'Orca Cloud is unreachable.'
    )
  })

  it('refuses saved workspace and thread refs for a run wait, including labelled refs', async () => {
    for (const place of ['github:42:workspace', 'github:42:777:8', 'github:42:user:7']) {
      const waiting: AutomationEventTrigger = {
        id: 'on-run',
        source: 'github',
        event: 'workflow_finished',
        in: [place],
        run: '9001',
        names: { [place]: 'acme/web' }
      }
      const resolve = vi.fn<ConnectorRefResolver>(async () => ({ ref: place, label: 'acme/web' }))
      await expect(withPlaceRefs(resolve, 'bot-1', { on: [waiting] })).rejects.toThrow('repo ref')
      await expect(
        withPlaceRefs(resolve, 'bot-1', { on: [waiting] }, { on: [waiting] })
      ).rejects.toThrow('repo ref')
      await expect(
        withPlaceRefs(null, 'bot-1', { on: [waiting] }, { on: [waiting] })
      ).rejects.toThrow('repo ref')
    }
    const waiting: AutomationEventTrigger = {
      id: 'on-run',
      source: 'github',
      event: 'workflow_finished',
      in: ['github:42:777'],
      run: '9001',
      names: { 'github:42:777': 'acme/web' }
    }
    await expect(
      withPlaceRefs(null, 'bot-1', { on: [waiting] }, { on: [waiting] })
    ).resolves.toEqual({ on: [waiting] })
    const wrong = vi.fn<ConnectorRefResolver>(async () => ({
      ref: 'github:42:workspace',
      label: 'acme'
    }))
    await expect(
      withPlaceRefs(wrong, 'bot-1', { on: [{ ...waiting, in: ['acme/web'] }] })
    ).rejects.toThrow('repo ref')
  })

  it('leaves webhook rules and the Chat alone', async () => {
    const resolve = cloud()
    const hook: AutomationEventTrigger = { id: 'hook-1', source: 'webhook', event: 'call', rev: 1 }
    await expect(
      withPlaceRefs(resolve, 'bot-1', { on: [hook], resultsTo: 'chat' })
    ).resolves.toEqual({
      on: [hook],
      resultsTo: 'chat'
    })
    expect(resolve).not.toHaveBeenCalled()
  })
})

import { describe, expect, it } from 'vitest'
import { CONNECTOR_LIMITS } from './connector-limits.js'
import { ConnectorHelloRequestSchema } from './hello-messages.js'
import { matchesTrigger, type ConnectorTrigger } from './trigger-messages.js'

const rule: ConnectorTrigger = {
  id: 't1',
  automationId: 'auto-1',
  botId: 'bot-1',
  source: 'slack',
  event: 'mentioned',
  graceMinutes: 720
}
const event = {
  source: 'slack',
  event: 'mentioned',
  actorId: 'U0MEMBER',
  in: 'C0INFRA',
  text: 'Deploys are FAILING'
} as const
const bot = { ownerUserId: 'U0OWNER', members: ['U0MEMBER'], botUserId: 'U0BOT' }

const hello = {
  v: 1,
  contract: 1,
  orcaVersion: '1.4.230',
  platform: 'darwin',
  runtime: 'desktop',
  hostName: 'mac',
  promptKinds: [],
  features: ['trigger'],
  sources: ['slack']
}

describe('matchesTrigger', () => {
  it('matches a run rule only on that exact run', () => {
    const waiting = {
      ...rule,
      source: 'github' as const,
      event: 'workflow_finished',
      in: ['acme/web'],
      run: '43633379052'
    }
    const finished = {
      source: 'github',
      event: 'workflow_finished',
      actorId: '7',
      in: 'acme/web'
    } as const
    expect(matchesTrigger(waiting, { ...finished, run: '43633379052' }, bot)).toBe(true)
    expect(matchesTrigger(waiting, { ...finished, run: '4363337905' }, bot)).toBe(false)
    expect(matchesTrigger(waiting, { ...finished, run: '436333790520' }, bot)).toBe(false)
    expect(matchesTrigger(waiting, finished, bot)).toBe(false)
    expect(matchesTrigger(waiting, { ...finished, in: 'acme/api', run: '43633379052' }, bot)).toBe(
      false
    )
  })

  it('reads a rule with a run id, and drops one whose run is not an id', () => {
    const waiting = { ...rule, source: 'github', event: 'workflow_finished', run: '42' }
    expect(
      ConnectorHelloRequestSchema.parse({ ...hello, triggers: [waiting] }).triggers
    ).toMatchObject([{ run: '42' }])
    for (const run of ['', 'abc', '12.5', 'https://github.com/acme/web/actions/runs/42']) {
      expect(
        ConnectorHelloRequestSchema.parse({ ...hello, triggers: [{ ...waiting, run }] }).triggers
      ).toEqual([])
    }
  })

  it('matches a label rule only on that label, in any case', () => {
    const labeled = { ...rule, source: 'github' as const, event: 'labeled', label: 'Needs-Review' }
    const given = { source: 'github', event: 'labeled', actorId: '7', in: 'acme/web' } as const
    expect(matchesTrigger(labeled, { ...given, label: 'needs-review' }, bot)).toBe(true)
    expect(matchesTrigger(labeled, { ...given, label: 'needs-review-later' }, bot)).toBe(false)
    expect(matchesTrigger(labeled, given, bot)).toBe(false)
    const { label: _label, ...anyLabel } = labeled
    expect(matchesTrigger(anyLabel, { ...given, label: 'bug' }, bot)).toBe(true)
  })

  it('matches source and event, then each filter the rule sets', () => {
    expect(matchesTrigger(rule, event, bot)).toBe(true)
    expect(matchesTrigger(rule, { ...event, event: 'message' }, bot)).toBe(false)
    expect(matchesTrigger(rule, { ...event, source: 'linear' }, bot)).toBe(false)
    expect(matchesTrigger({ ...rule, in: ['C0ENG', 'C0INFRA'] }, event, bot)).toBe(true)
    expect(matchesTrigger({ ...rule, in: ['C0ENG'] }, event, bot)).toBe(false)
    expect(matchesTrigger({ ...rule, textContains: 'deploys are failing' }, event, bot)).toBe(true)
    expect(matchesTrigger({ ...rule, textContains: 'rollback' }, event, bot)).toBe(false)
    expect(matchesTrigger({ ...rule, subject: 'acme/web#482' }, event, bot)).toBe(false)
    expect(
      matchesTrigger(
        { ...rule, subject: 'acme/web#482' },
        { ...event, subject: 'acme/web#482' },
        bot
      )
    ).toBe(true)
    // A name's case doesn't matter, as on GitHub.
    expect(
      matchesTrigger(
        { ...rule, in: ['acme/web'], subject: 'acme/web#482' },
        { ...event, in: 'Acme/Web', subject: 'Acme/Web#482' },
        bot
      )
    ).toBe(true)
  })

  it('matches a rule naming refs by the event\'s refs, and an older rule by its names', () => {
    const atRefs = { ...event, inRef: 'slack:T1:C0INFRA', subjectRef: 'slack:T1:C0INFRA:1700.1' }
    expect(matchesTrigger({ ...rule, in: ['slack:T1:C0INFRA'] }, atRefs, bot)).toBe(true)
    expect(matchesTrigger({ ...rule, in: ['slack:T1:C0ENG'] }, atRefs, bot)).toBe(false)
    // A rule written before refs still matches the event's names.
    expect(matchesTrigger({ ...rule, in: ['C0INFRA'] }, atRefs, bot)).toBe(true)
    // An event a source sent without refs matches no ref rule.
    expect(matchesTrigger({ ...rule, in: ['slack:T1:C0INFRA'] }, event, bot)).toBe(false)
    expect(matchesTrigger({ ...rule, subject: 'slack:T1:C0INFRA:1700.1' }, atRefs, bot)).toBe(true)
    expect(matchesTrigger({ ...rule, subject: 'slack:T1:C0INFRA:1700.2' }, atRefs, bot)).toBe(false)
    // The repo, not the installation that delivered it: a reinstall keeps the rule.
    const github = { ...event, source: 'github', inRef: 'github:99:777', subjectRef: 'github:99:777:5' } as const
    const githubRule: ConnectorTrigger = { ...rule, source: 'github', in: ['github:42:777'], subject: 'github:42:777:5' }
    expect(matchesTrigger(githubRule, github, bot)).toBe(true)
    expect(matchesTrigger({ ...githubRule, subject: 'github:42:777:6' }, github, bot)).toBe(false)
    expect(matchesTrigger({ ...githubRule, in: ['github:42:778'] }, github, bot)).toBe(false)
  })

  it('matches a workspace ref anywhere in that workspace, and nowhere else', () => {
    const linear = { ...event, source: 'linear', in: 'ENG', inRef: 'linear:org-1:team:team-eng' } as const
    const anywhere: ConnectorTrigger = { ...rule, source: 'linear', in: ['linear:org-1:workspace'] }
    expect(matchesTrigger(anywhere, linear, bot)).toBe(true)
    // A comment whose team the source didn't read still names its workspace.
    expect(matchesTrigger(anywhere, { ...linear, inRef: 'linear:org-1:workspace' }, bot)).toBe(true)
    expect(matchesTrigger(anywhere, { ...linear, inRef: 'linear:org-2:team:team-eng' }, bot)).toBe(false)
    expect(matchesTrigger(anywhere, { ...linear, inRef: 'slack:org-1:C0INFRA' }, bot)).toBe(false)
    // A team ref doesn't match an event that names only its workspace.
    const team: ConnectorTrigger = { ...rule, source: 'linear', in: ['linear:org-1:team:team-eng'] }
    expect(matchesTrigger(team, { ...linear, inRef: 'linear:org-1:workspace' }, bot)).toBe(false)
    const slack = { ...event, inRef: 'slack:T1:C0INFRA' }
    expect(matchesTrigger({ ...rule, in: ['slack:T1:workspace'] }, slack, bot)).toBe(true)
    expect(matchesTrigger({ ...rule, in: ['slack:T2:workspace'] }, slack, bot)).toBe(false)
  })

  it('starts for anyone but the bot itself, as Who can ask gates only asking it', () => {
    expect(matchesTrigger(rule, { ...event, actorId: 'U0OWNER' }, bot)).toBe(true)
    expect(matchesTrigger(rule, { ...event, actorId: 'U0STRANGER' }, bot)).toBe(true)
    expect(matchesTrigger(rule, { ...event, actorId: 'U0BOT' }, bot)).toBe(false)
  })

  it('narrows to the people a rule names, and to reactions on the owner\'s own messages', () => {
    const fromDana = { ...rule, from: ['U0DANA'] }
    expect(matchesTrigger(fromDana, { ...event, actorId: 'U0DANA' }, bot)).toBe(true)
    expect(matchesTrigger(fromDana, { ...event, actorId: 'U0MEMBER' }, bot)).toBe(false)
    const reaction = { ...event, event: 'reaction' }
    const mine = { ...rule, event: 'reaction', onOwnerMessage: true as const }
    expect(matchesTrigger(mine, { ...reaction, itemAuthorId: 'U0OWNER' }, bot)).toBe(true)
    expect(matchesTrigger(mine, { ...reaction, itemAuthorId: 'U0MEMBER' }, bot)).toBe(false)
    expect(matchesTrigger(mine, reaction, bot)).toBe(false)
  })

  it("takes the owner's own events only for a rule that says so, beside the people it names", () => {
    const github = { ...event, source: 'github', event: 'pr_opened' } as const
    const mine: ConnectorTrigger = { ...rule, source: 'github', event: 'pr_opened', fromOwner: true }
    expect(matchesTrigger(mine, { ...github, actorId: 'U0OWNER' }, bot)).toBe(true)
    expect(matchesTrigger(mine, { ...github, actorId: 'U0DANA' }, bot)).toBe(false)
    const withDana = { ...mine, from: ['U0DANA'] }
    expect(matchesTrigger(withDana, { ...github, actorId: 'U0OWNER' }, bot)).toBe(true)
    expect(matchesTrigger(withDana, { ...github, actorId: 'U0DANA' }, bot)).toBe(true)
    expect(matchesTrigger(withDana, { ...github, actorId: 'U0SAM' }, bot)).toBe(false)
    // Without it, a rule naming people leaves the owner out, as before.
    expect(matchesTrigger({ ...rule, from: ['U0DANA'] }, { ...event, actorId: 'U0OWNER' }, bot)).toBe(false)
    // Never the bot itself.
    expect(matchesTrigger(mine, { ...github, actorId: 'U0BOT' }, { ...bot, ownerUserId: 'U0BOT' })).toBe(false)
  })

  it('reads a text filter only within the quoted length', () => {
    const late = { ...event, text: `${'x'.repeat(CONNECTOR_LIMITS.maxTriggerTextLength)}needle` }
    expect(matchesTrigger({ ...rule, textContains: 'needle' }, late, bot)).toBe(false)
  })
})

describe('hello triggers', () => {
  it('drops rules this cloud cannot read and keeps the rest of the hello', () => {
    const parsed = ConnectorHelloRequestSchema.parse({
      ...hello,
      triggers: [rule, { ...rule, id: 't2', source: 'teams' }, { id: 't3' }]
    })
    expect(parsed.triggers).toEqual([rule])
  })

  it('fits one request with every bot and every trigger at its caps', () => {
    const id = (prefix: string) => prefix.padEnd(CONNECTOR_LIMITS.maxBotIdLength, 'x')
    const bot = {
      id: id('b'),
      name: 'n'.repeat(CONNECTOR_LIMITS.maxDisplayTextLength),
      agent: 'claude',
      members: Array.from({ length: CONNECTOR_LIMITS.maxBotMembers }, () => 'U'.repeat(32)),
      paused: false
    }
    const largest = {
      ...rule,
      id: id('t'),
      automationId: id('a'),
      botId: id('b'),
      event: 'e'.repeat(64),
      in: Array.from({ length: CONNECTOR_LIMITS.maxTriggerPlaces }, () => id('c')),
      textContains: 't'.repeat(CONNECTOR_LIMITS.maxDisplayTextLength),
      subject: 's'.repeat(CONNECTOR_LIMITS.maxDisplayTextLength)
    }
    const body = JSON.stringify({
      ...hello,
      bots: Array.from({ length: CONNECTOR_LIMITS.maxHelloBots }, () => bot),
      triggers: Array.from({ length: CONNECTOR_LIMITS.maxHelloTriggers }, () => largest)
    })
    expect(ConnectorHelloRequestSchema.parse(JSON.parse(body)).triggers).toHaveLength(
      CONNECTOR_LIMITS.maxHelloTriggers
    )
    expect(Buffer.byteLength(body)).toBeLessThan(CONNECTOR_LIMITS.maxRequestBytes)
  })
})

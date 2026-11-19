import { describe, expect, it } from 'vitest'
import {
  formatAutomationEventTrigger,
  formatAutomationTriggerOptions,
  offeredEvents,
  parseAutomationEventTrigger
} from './automation-event-trigger-spec'

const WORKFLOW_RUN = 'https://github.com/acme/widgets/actions/runs/9000000001'

describe('--on trigger specs', () => {
  it('reads an event with its filters', () => {
    expect(
      parseAutomationEventTrigger(
        'slack.mentioned in=C2,C1 contains="deploy \\"now\\"" subject=T:C:1'
      )
    ).toMatchObject({
      source: 'slack',
      event: 'mentioned',
      in: ['C1', 'C2'],
      textContains: 'deploy "now"',
      subject: 'T:C:1'
    })
  })

  it('formats a trigger back to the spec it was read from', () => {
    const trigger = parseAutomationEventTrigger('slack.message subject=T:C:1 contains="a b"')
    expect(formatAutomationEventTrigger(trigger)).toBe('slack.message contains="a b" subject=T:C:1')
    expect(parseAutomationEventTrigger(formatAutomationEventTrigger(trigger))).toEqual(trigger)
  })

  it('parses and formats webhook filters for a new hook', () => {
    const trigger = parseAutomationEventTrigger(
      'webhook.call where="body.action in opened, reopened" where="headers.X-GitHub-Event = pull_request" where="body.draft !exists" contains="deploy now" pick=body.number,body.title subject-from=body.number subject=4512'
    )
    expect(trigger).toEqual({
      id: '',
      source: 'webhook',
      event: 'call',
      rev: 0,
      where: [
        { path: 'body.action', op: 'in', values: ['opened', 'reopened'] },
        { path: 'headers.X-GitHub-Event', op: '=', values: ['pull_request'] },
        { path: 'body.draft', op: '!exists' }
      ],
      textContains: 'deploy now',
      pick: ['body.number', 'body.title'],
      subjectFrom: 'body.number',
      subject: '4512'
    })
    expect(formatAutomationEventTrigger(trigger)).toBe(
      'webhook.call where="body.action in opened,reopened" where="headers.X-GitHub-Event = pull_request" where="body.draft !exists" contains="deploy now" pick=body.number,body.title subject-from=body.number subject=4512'
    )
    // One value may hold commas; only `in` lists.
    expect(
      parseAutomationEventTrigger('webhook.call where="body.title contains a, b"')
    ).toMatchObject({
      where: [{ path: 'body.title', op: 'contains', values: ['a, b'] }]
    })
  })

  it('keeps one id for the same rule however it is written', () => {
    const a = parseAutomationEventTrigger('slack.message in=C1,C2')
    const b = parseAutomationEventTrigger('  slack.message   in=C2,C1,C2 ')
    expect(a.id).toMatch(/^on-[0-9a-f]{16}$/)
    expect(b.id).toBe(a.id)
    expect(parseAutomationEventTrigger('slack.message in=C1').id).not.toBe(a.id)
  })

  it.each([
    ['', '--on needs an event'],
    ['slack', 'Unknown event "slack"'],
    ['slack.pinged', 'Unknown event "slack.pinged"'],
    ['slack.message in=C1,', 'needs in= to list places'],
    ['slack.mentioned.extra', 'Unknown event'],
    ['slack.mentioned on=mine', 'on=mine is for slack.reaction only'],
    ['slack.reaction on=yours', 'on=mine is for slack.reaction only'],
    ['slack.mentioned from=,', 'needs from= to list people'],
    ['slack.mentioned who=me', 'Unknown filter "who=me"'],
    ['slack.mentioned deploy', 'Unknown filter "deploy"'],
    ['slack.mentioned in=C1 in=C2', 'needs one value for in='],
    ['slack.mentioned contains=', 'needs one value for contains='],
    ['webhook.call in=C0123', 'Unknown filter "in="'],
    ['webhook.call where="body.action ~ x"', 'where= takes "<path> <op> <value>"'],
    ['webhook.call pick=a pick=b', 'needs one value for pick=']
  ])('refuses %j', (spec, message) => {
    expect(() => parseAutomationEventTrigger(spec)).toThrow(message)
  })

  it('keeps a name, link or ref as written, for the host to look up; an id or key in its one spelling', () => {
    expect(parseAutomationEventTrigger('slack.mentioned in=#eng,c0123abcd')).toMatchObject({
      in: ['#eng', 'C0123ABCD']
    })
    expect(
      parseAutomationEventTrigger('github.pr_opened in=Acme/Web subject=Acme/Web#8')
    ).toMatchObject({
      in: ['acme/web'],
      subject: 'acme/web#8'
    })
    expect(
      parseAutomationEventTrigger('linear.issue_created in=linear:org-1:team:t1 subject=ENG-7')
    ).toMatchObject({
      in: ['linear:org-1:team:t1'],
      subject: 'ENG-7'
    })
  })

  it('takes from= people as written and on=mine, keeping the id of a rule without them', () => {
    const plain = parseAutomationEventTrigger('slack.reaction in=C1')
    const narrowed = parseAutomationEventTrigger('slack.reaction in=C1 from=@sam,@dana on=mine')
    expect(narrowed).toMatchObject({ from: ['@dana', '@sam'], onOwnerMessage: true })
    expect(narrowed.id).not.toBe(plain.id)
    expect(parseAutomationEventTrigger(formatAutomationEventTrigger(narrowed))).toEqual(narrowed)
    expect(plain.id).toBe(parseAutomationEventTrigger('slack.reaction in=C1').id)
  })

  it('reads a pasted Slack channel or message link as its channel id', () => {
    expect(
      parseAutomationEventTrigger(
        'slack.mentioned in=https://acme.slack.com/archives/C0123ABCD,https://acme.slack.com/archives/C0999/p1800000000000100?thread_ts=1800000000.000100&cid=C0999,https://app.slack.com/client/T0123/g0456'
      )
    ).toMatchObject({ in: ['C0123ABCD', 'C0999', 'G0456'] })
    expect(
      parseAutomationEventTrigger('slack.message in=https://acme.slack.com/archives/C1')
    ).toEqual(parseAutomationEventTrigger('slack.message in=C1'))
  })

  it('reads a GitHub rule on one pull request', () => {
    expect(parseAutomationEventTrigger('github.ci_failed subject=acme/web#482')).toMatchObject({
      source: 'github',
      event: 'ci_failed',
      subject: 'acme/web#482'
    })
    // One spelling of a GitHub name, so its rule keeps one id.
    const mixed = parseAutomationEventTrigger('github.pr_opened in=Acme/Web subject=Acme/Web#1')
    expect(mixed).toEqual(
      parseAutomationEventTrigger('github.pr_opened in=acme/web subject=acme/web#1')
    )
    expect(mixed).toMatchObject({ in: ['acme/web'], subject: 'acme/web#1' })
  })

  it('normalizes a GitHub run link and round-trips the workflow filter', () => {
    const parse = (spec: string) => parseAutomationEventTrigger(`github.workflow_finished ${spec}`)
    const rule = parse(`run=${WORKFLOW_RUN} contains="[conclusion=failure]"`)
    expect(rule).toMatchObject({
      source: 'github',
      event: 'workflow_finished',
      in: ['acme/widgets'],
      run: '9000000001'
    })
    for (const suffix of ['/job/132625440486', '/', '?pr=8']) {
      expect(parse(`in=Acme/Widgets run=${WORKFLOW_RUN}${suffix}`)).toMatchObject({
        in: ['acme/widgets'],
        run: '9000000001'
      })
    }
    const spec = formatAutomationEventTrigger(rule)
    expect(spec).toBe(
      'github.workflow_finished in=acme/widgets contains=[conclusion=failure] run=9000000001'
    )
    expect(parseAutomationEventTrigger(spec)).toEqual(rule)
    expect(parseAutomationEventTrigger(spec.replace('9000000001', '9000000002')).id).not.toBe(
      rule.id
    )
  })

  it('rejects ambiguous, unrelated or misplaced GitHub workflow run filters', () => {
    const parse = (spec: string) => parseAutomationEventTrigger(`github.workflow_finished ${spec}`)
    expect(() => parse(`run=${WORKFLOW_RUN}/attempts/2`)).toThrow('without /attempts/')
    for (const run of [
      'https://github.com/acme/widgets/pull/8',
      'https://example.com/a/b/actions/runs/1',
      'latest'
    ]) {
      expect(() => parse(`run=${run}`)).toThrow("run= takes the run's link")
    }
    expect(() => parseAutomationEventTrigger(`github.ci_failed run=${WORKFLOW_RUN}`)).toThrow(
      'run= is for github.workflow_finished only'
    )
    expect(() => parse(`in=acme/infra run=${WORKFLOW_RUN}`)).toThrow('the run is in acme/widgets')
    expect(() => parse('run=42')).toThrow('run=<id> needs in=')
  })

  it('reads label= on github.labeled only, keeping the id of a rule without it', () => {
    const bug = parseAutomationEventTrigger('github.labeled in=acme/web label="Needs review"')
    expect(bug).toMatchObject({ event: 'labeled', label: 'Needs review' })
    expect(formatAutomationEventTrigger(bug)).toBe(
      'github.labeled in=acme/web label="Needs review"'
    )
    expect(parseAutomationEventTrigger(formatAutomationEventTrigger(bug))).toEqual(bug)
    // Its case doesn't make another rule.
    expect(parseAutomationEventTrigger('github.labeled in=acme/web label="needs REVIEW"').id).toBe(
      bug.id
    )
    expect(parseAutomationEventTrigger('github.labeled in=acme/web').id).not.toBe(bug.id)
    expect(() => parseAutomationEventTrigger('github.comment label=bug')).toThrow(
      'label= is for github.labeled only'
    )
    // Blank once trimmed: refused, never saved as a rule on every label.
    expect(() => parseAutomationEventTrigger('github.labeled in=acme/web label="   "')).toThrow(
      'needs label= to name a label'
    )
  })

  it('reads from=me as your own pull requests, on github.pr_opened only', () => {
    const mine = parseAutomationEventTrigger('github.pr_opened in=acme/web from=me')
    expect(mine).toMatchObject({ source: 'github', event: 'pr_opened', fromOwner: true })
    expect(mine).not.toHaveProperty('from')
    expect(formatAutomationEventTrigger(mine)).toBe('github.pr_opened in=acme/web from=me')
    expect(parseAutomationEventTrigger(formatAutomationEventTrigger(mine))).toEqual(mine)
    // Beside other people, and however me is written.
    const withDana = parseAutomationEventTrigger('github.pr_opened from=@dana,@Me')
    expect(withDana).toMatchObject({ from: ['@dana'], fromOwner: true })
    expect(formatAutomationEventTrigger(withDana)).toBe('github.pr_opened from=me,@dana')
    // Its own id, and the rules without it keep theirs.
    const anyone = parseAutomationEventTrigger('github.pr_opened in=acme/web')
    expect(mine.id).not.toBe(anyone.id)
    expect(parseAutomationEventTrigger('github.pr_opened from=@dana').id).not.toBe(withDana.id)
    for (const spec of [
      'github.comment from=me',
      'github.pr_pushed from=me',
      'slack.message from=me'
    ]) {
      expect(() => parseAutomationEventTrigger(spec)).toThrow(
        'from=me is for github.pr_opened only'
      )
    }
  })

  it("offers newer GitHub events and webhooks according to the bot's cloud capabilities", () => {
    const bot = { name: 'Scout', github: {} }
    const older = formatAutomationTriggerOptions('github', bot)
    expect(older).not.toContain('github.ci_passed  when')
    expect(older).not.toContain('label=<name>')
    expect(older).toContain('github.ci_failed  when')
    expect(older).toContain("Scout's Orca Cloud doesn't send github.ci_passed")
    expect(offeredEvents('github', bot)).not.toContain('ci_passed')
    expect(offeredEvents('github', bot)).toContain('ci_failed')
    const newer = { ...bot, githubEvents2: true }
    expect(formatAutomationTriggerOptions('github', newer)).toContain('github.ci_passed  when')
    expect(formatAutomationTriggerOptions('github', newer)).toContain('label=<name>')
    expect(formatAutomationTriggerOptions('github', newer)).not.toContain("doesn't send")
    expect(offeredEvents('github', newer)).toContain('security_alert')
    expect(offeredEvents('slack', bot)).toEqual(['mentioned', 'message', 'reaction'])
    expect(formatAutomationTriggerOptions(undefined, { name: 'Scout' })).not.toContain(
      'webhook.call'
    )
    expect(formatAutomationTriggerOptions(undefined, { name: 'Scout', webhooks: true })).toContain(
      'webhook.call'
    )
  })
})

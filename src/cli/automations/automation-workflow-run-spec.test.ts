import { describe, expect, it } from 'vitest'
import {
  formatAutomationEventTrigger,
  offeredEvents,
  parseAutomationEventTrigger
} from './automation-event-trigger-spec'
import { isConnectorTrigger } from '../../shared/automation-event-triggers'

// A GitHub rule, as --on reads it.
function parseRule(spec: string) {
  const rule = parseAutomationEventTrigger(spec)
  if (!isConnectorTrigger(rule)) {
    throw new Error(`not a connector rule: ${spec}`)
  }
  return rule
}

const LINK = 'https://github.com/acme/widgets/actions/runs/9000000001'

describe('github.workflow_finished run=', () => {
  it("reads the run's link as its id and repo", () => {
    expect(parseAutomationEventTrigger(`github.workflow_finished run=${LINK}`)).toMatchObject({
      source: 'github',
      event: 'workflow_finished',
      in: ['acme/widgets'],
      run: '9000000001'
    })
    // A job's link, a trailing slash or a query still name the run.
    for (const link of [`${LINK}/job/132625440486`, `${LINK}/`, `${LINK}?pr=8`]) {
      expect(parseRule(`github.workflow_finished run=${link}`).run).toBe('9000000001')
    }
  })

  it('formats back to a spec that reads as the same rule, with the same id', () => {
    const rule = parseAutomationEventTrigger(
      `github.workflow_finished run=${LINK} contains="[conclusion=failure]"`
    )
    const spec = formatAutomationEventTrigger(rule)
    expect(spec).toBe(
      'github.workflow_finished in=acme/widgets contains=[conclusion=failure] run=9000000001'
    )
    expect(parseAutomationEventTrigger(spec)).toEqual(rule)
    const other = parseAutomationEventTrigger(
      'github.workflow_finished in=acme/widgets run=9000000002'
    )
    expect(other.id).not.toBe(rule.id)
  })

  it('refuses a link to one attempt, a link that is no run, and run= anywhere else', () => {
    expect(() =>
      parseAutomationEventTrigger(`github.workflow_finished run=${LINK}/attempts/2`)
    ).toThrow('without /attempts/')
    for (const run of [
      'https://github.com/acme/widgets/pull/8',
      'https://example.com/a/b/actions/runs/1',
      'latest'
    ]) {
      expect(() => parseAutomationEventTrigger(`github.workflow_finished run=${run}`)).toThrow(
        "run= takes the run's link"
      )
    }
    expect(() => parseAutomationEventTrigger(`github.ci_failed run=${LINK}`)).toThrow(
      'run= is for github.workflow_finished only'
    )
  })

  it('takes in= only as the repo the link names, and a bare id only beside one repo', () => {
    expect(parseRule(`github.workflow_finished in=Acme/Widgets run=${LINK}`).in).toEqual([
      'acme/widgets'
    ])
    expect(() =>
      parseAutomationEventTrigger(`github.workflow_finished in=acme/infra run=${LINK}`)
    ).toThrow('the run is in acme/widgets')
    expect(() => parseAutomationEventTrigger('github.workflow_finished run=42')).toThrow(
      'run=<id> needs in='
    )
  })

  it("is offered only where the bot's Orca Cloud sends it", () => {
    const bot = { name: 'Scout', github: {}, githubEvents2: true }
    expect(offeredEvents('github', bot)).not.toContain('workflow_finished')
    expect(offeredEvents('github', { ...bot, githubWorkflows: true })).toContain(
      'workflow_finished'
    )
  })
})

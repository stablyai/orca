// The stand-in reads, searches and sets as Orca Cloud's own verbs answered for the same world
// (the connector service records those answers from its real verb code).
import { describe, expect, it } from 'vitest'
import ANSWERS from './bot-automation-eval-linear-answers.json'
import { ConnectorActionArgs } from '../../shared/connector-action-contract'
import {
  linearIssue,
  linearTeam,
  ownerLinearIssue,
  readLinearIssue,
  searchLinear
} from './bot-automation-eval-linear'
import { createLinear, setLinear } from './bot-automation-eval-linear-writes'

describe('stand-in Linear', () => {
  it.each(ANSWERS.searches)(
    'searches $team for $search as the cloud did',
    ({ team, search, answer }) => {
      expect(searchLinear(team ?? 'linear:lin-eval:workspace', search)).toEqual(answer)
    }
  )

  it('reads each issue with the fields the cloud read for it', () => {
    for (const [key, facts] of Object.entries(ANSWERS.facts)) {
      expect(readLinearIssue(linearIssue(key)!).facts).toEqual(facts)
    }
  })

  it.each(ANSWERS.sets)('sets $issue to $fields as the cloud did', ({ issue, fields, answer }) => {
    const parsed = ConnectorActionArgs.parse({ fields }).fields!
    expect(setLinear(linearIssue(issue)!, parsed).answer).toEqual(answer)
  })

  it.each(ANSWERS.creates)('creates $title in $team as the cloud did', (recorded) => {
    const { team, key, title, answer } = recorded
    const fields =
      'fields' in recorded
        ? ConnectorActionArgs.parse({ fields: recorded.fields }).fields
        : undefined
    const parent =
      'parent' in recorded && recorded.parent ? linearIssue(recorded.parent) : undefined
    const text = 'text' in recorded ? recorded.text : undefined
    const { answer: made, made: issue } = createLinear(linearTeam(team)!, {
      key,
      title,
      ...(text ? { text } : {}),
      ...(parent ? { parent } : {}),
      ...(fields ? { fields } : {})
    })
    expect(made).toEqual(answer)
    if ('parentFacts' in recorded) {
      expect(readLinearIssue(parent!, { created: [issue!] }).facts).toEqual(recorded.parentFacts)
    }
  })

  it('answers a retry of the same post with the issue it made, never a second', () => {
    const team = linearTeam('PLAT')!
    const first = createLinear(team, { key: 'k1', title: 'Export does nothing' })
    const retry = createLinear(
      team,
      { key: 'k1', title: 'Export does nothing' },
      { created: [first.made!] }
    )
    expect(retry.made).toBeUndefined()
    expect(retry.answer).toEqual(first.answer)
  })

  it('reads, searches and numbers after an issue a run made', () => {
    const { made } = createLinear(linearTeam('PLAT')!, {
      key: 'k1',
      title: 'Export button does nothing on Safari'
    })
    const run = { created: [made!] }
    expect(linearIssue('PLAT-48', run)?.title).toBe('Export button does nothing on Safari')
    expect(searchLinear('PLAT', { state: 'triage' }, 20, run)).toMatchObject({
      result: {
        matches: expect.arrayContaining([
          expect.objectContaining({ ref: `linear:lin-eval:${made!.id}` })
        ])
      }
    })
    expect(
      createLinear(linearTeam('PLAT')!, { key: 'k2', title: 'Next' }, run).made?.identifier
    ).toBe('PLAT-49')
  })

  it('reads an issue as a set left it', () => {
    const issue = linearIssue('ENG-9310')!
    const { change } = setLinear(issue, { state: 'In Progress' })
    const moved = linearIssue('ENG-9310', { changes: { 'ENG-9310': change! } })!
    expect(readLinearIssue(moved).facts.state).toEqual({ name: 'In Progress', type: 'started' })
    expect(readLinearIssue(issue).facts.state).toEqual({ name: 'In Review', type: 'started' })
    const sized = setLinear(linearIssue('PLAT-47')!, { estimate: 3 }).change!
    expect(ownerLinearIssue('PLAT-47', { changes: { 'PLAT-47': sized } })?.estimate).toBe(3)
  })

  it('names an issue by key, link or ref, and refuses a name that means nothing', () => {
    expect(linearIssue('https://linear.app/eval/issue/ENG-9310/exports')?.identifier).toBe(
      'ENG-9310'
    )
    expect(linearIssue('linear:lin-eval:issue-plat-44')?.identifier).toBe('PLAT-44')
    expect(linearIssue('ENG-93100')).toBeUndefined()
  })
})

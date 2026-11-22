// The stand-in finds Slack people as Orca Cloud's own lookup did for the same world
// and searches as its search did (the connector service records those answers from its real code).
import { describe, expect, it } from 'vitest'
import ANSWERS from './bot-automation-eval-slack-answers.json'
import { findSlackPerson, slackPeople, slackWorkspaceNamed } from './bot-automation-eval-slack'
import { searchSlackAsOwner, searchSlack } from './bot-automation-eval-slack-search'

describe('stand-in Slack people', () => {
  it.each(Object.entries(ANSWERS.people))('finds "%s" as the cloud did', (name, found) => {
    expect(slackPeople(name)).toEqual(found)
  })

  it.each(Object.entries(ANSWERS.named))(
    'finds the workspace by "%s" as the cloud did',
    (name, found) => {
      expect(slackWorkspaceNamed(name)).toEqual(found)
    }
  )

  it('finds no workspace by a #channel, a link or part of its name', () => {
    for (const input of ['#eval', 'https://eval.slack.com', 'Evals', 'Ev']) {
      expect(slackWorkspaceNamed(input), input).toEqual([])
    }
  })

  it.each(ANSWERS.conversations)(
    'says whether $channel was searched, as the cloud did',
    ({ channel, thread, answer }) => {
      expect({ ok: true, result: searchSlack('U0OWNER', 'export', { channel, thread }) }).toEqual(
        answer
      )
    }
  )

  it.each(ANSWERS.searches)(
    'searches "$query" as $asker as the cloud did',
    ({ asker, query, answer }) => {
      expect({ ok: true, result: searchSlack(asker, query) }).toEqual(answer)
    }
  )

  it('takes @name, user:<id> and a mention, and names each person by ref with their profile', () => {
    expect(findSlackPerson('@Bob')).toEqual([
      {
        ref: 'slack:T0EVAL:user:U0BOB',
        label: 'Bob Lee @bob · Engineer, exports · bob@example.com · America/Los_Angeles',
        exact: true
      }
    ])
    expect(findSlackPerson('user:U0NORA')).toEqual(findSlackPerson('<@U0NORA>'))
    expect(findSlackPerson('slack:T0EVAL:user:U0NORA')).toEqual(findSlackPerson('<@U0NORA>'))
    expect(findSlackPerson('@deploybot')).toEqual([])
    expect(findSlackPerson('#exports')).toBeNull()
  })

  it('searches as the owner through their own tool: their private channels and DMs too', () => {
    const found = searchSlackAsOwner('export', { user: 'bob' }).map((hit) => hit.channel_id)
    expect(found).toEqual(expect.arrayContaining(['C0LEADS', 'D0BOB', 'C0PLATENG', 'C0DESIGN']))
    expect(found).not.toContain('C0EXPORTS')
    expect(
      searchSlackAsOwner('export in:leads after:2026-01-01').map((hit) => hit.channel_id)
    ).toEqual(['C0LEADS'])
    expect(
      searchSlackAsOwner('export', { channels: ['leads', '#platform-eng'] }).map(
        (hit) => hit.channel_id
      )
    ).toEqual(['C0LEADS', 'C0PLATENG', 'C0PLATENG'])
  })
})

// Each identity check meets a trace that gets it right and the wrong ones it exists to reject.
import { describe, expect, it } from 'vitest'
import { BOT_QUIET_MARKER } from '../../shared/bot-quiet-result'
import type { EvalRecordedWrite, EvalTurnOutcome } from './bot-orchestration-eval-conversation'
import type { TurnCheck } from './bot-orchestration-eval-grading'
import {
  answersWhereWoken,
  BOT_REPLY_METHOD,
  commentReviews,
  ghEdits,
  linearFiles,
  linearMovesTo,
  notesWhereWoken,
  reportsGap,
  speaksOnlyAsItselfOn,
  tagsAsker,
  tagsNoAsker,
  worksAsOwner
} from './bot-orchestration-eval-identity-grading'

function turn(over: Partial<EvalTurnOutcome> = {}): EvalTurnOutcome {
  return {
    reply: 'Done.',
    commands: [],
    writes: [],
    shell: [],
    tools: [],
    ownerTools: [],
    ...over
  }
}
const passes = (check: TurnCheck, outcome: EvalTurnOutcome) => expect(check(outcome)).toEqual([])
const fails = (check: TurnCheck, outcome: EvalTurnOutcome) =>
  expect(check(outcome).length).toBeGreaterThan(0)

const gh = (method: string, params: Record<string, unknown>): EvalRecordedWrite => ({
  method,
  params: { argv: [], ...params }
})

describe('identity checks', () => {
  it('ghEdits: the labels and assignees land on that issue, by flag or through gh api', () => {
    const check = ghEdits('stablyai/orca#12971', {
      labels: ['bug'],
      assignees: ['alice-eval']
    })
    const edit = (repo: string, number: number) =>
      gh('gh.issue.edit', {
        repo,
        number,
        addLabels: ['bug'],
        addAssignees: ['alice-eval']
      })
    passes(check, turn({ writes: [edit('stablyai/orca', 12971)] }))
    passes(
      check,
      turn({
        writes: [
          gh('gh.issue.edit', {
            repo: 'stablyai/orca',
            number: 12971,
            argv: ['api', 'repos/stablyai/orca/issues/12971/labels', '-f', 'labels[]=bug']
          }),
          gh('gh.issue.edit', {
            repo: 'stablyai/orca',
            number: 12971,
            argv: [
              'api',
              'repos/stablyai/orca/issues/12971/assignees',
              '-f',
              'assignees[]=alice-eval'
            ]
          })
        ]
      })
    )
    fails(check, turn({ writes: [edit('stablyai/orca', 1297)] }))
    fails(check, turn({ reply: "I can't label issues without the GitHub connector." }))
  })

  it('speaksOnlyAsItselfOn: edits on the waking place are fine; a comment or review there is not', () => {
    const check = speaksOnlyAsItselfOn('acme/api#17')
    passes(check, turn({ writes: [gh('gh.issue.edit', { repo: 'acme/api', number: 17 })] }))
    passes(
      check,
      turn({
        writes: [gh('gh.issue.comment', { repo: 'acme/api', number: 18 })]
      })
    )
    fails(
      check,
      turn({
        writes: [gh('gh.issue.comment', { repo: 'ACME/api', number: 17 })]
      })
    )
    fails(check, turn({ writes: [gh('gh.pr.review', { repo: 'acme/api', number: 17 })] }))
    const linear = speaksOnlyAsItselfOn('ENG-9310')
    passes(
      linear,
      turn({
        commands: [['linear', 'status', 'set', 'ENG-9310', '--to', 'Done']]
      })
    )
    fails(
      linear,
      turn({
        commands: [['linear', 'comment', 'add', 'eng-9310', '--body', 'x']]
      })
    )
  })

  it('answersWhereWoken: a final answer or a bot reply, not a quiet turn', () => {
    passes(answersWhereWoken, turn())
    passes(
      answersWhereWoken,
      turn({
        reply: BOT_QUIET_MARKER,
        writes: [{ method: BOT_REPLY_METHOD, params: { text: 'x' } }]
      })
    )
    fails(answersWhereWoken, turn({ reply: BOT_QUIET_MARKER }))
    fails(answersWhereWoken, turn({ reply: '' }))
  })

  it('notesWhereWoken: line notes on that file through `orca bot reply`', () => {
    const check = notesWhereWoken('uploader.ts')
    const reply = (path: string): EvalRecordedWrite => ({
      method: BOT_REPLY_METHOD,
      params: {
        text: 'Review',
        review: { comments: [{ path, line: 43, body: 'No backoff' }] }
      }
    })
    passes(check, turn({ writes: [reply('src/uploader.ts')] }))
    fails(check, turn({ writes: [reply('src/options.ts')] }))
    fails(
      check,
      turn({
        writes: [{ method: BOT_REPLY_METHOD, params: { text: 'LGTM' } }]
      })
    )
  })

  it('commentReviews: a comment review with gh, never an approval, and not a bot reply', () => {
    const check = commentReviews('acme/api#21', /maxTries/)
    const review = (event: string, body = 'maxTries is still read in uploader.ts') =>
      gh('gh.pr.review', { repo: 'acme/api', number: 21, event, body })
    passes(check, turn({ writes: [review('comment')] }))
    fails(check, turn({ writes: [review('approve')] }))
    fails(check, turn({ writes: [review('comment', 'Looks fine')] }))
    fails(
      check,
      turn({
        writes: [{ method: BOT_REPLY_METHOD, params: { text: 'maxTries' } }]
      })
    )
  })

  it('tagsAsker: a comment for a teammate ends with who asked, through which bot', () => {
    const check = tagsAsker('acme/api#17', 'Nora', 'Ranger')
    const comment = (body: string) => gh('gh.issue.comment', { repo: 'acme/api', number: 17, body })
    passes(
      check,
      turn({
        writes: [comment('In review in #18.\n\n_asked by Nora via Ranger_')]
      })
    )
    fails(check, turn({ writes: [comment('In review in #18.')] }))
    fails(check, turn({ writes: [comment('asked by Norabelle via Ranger')] }))
  })

  it('tagsNoAsker: no asked-by line on an owner-asked comment or any Slack post', () => {
    passes(tagsNoAsker, turn({ writes: [gh('gh.issue.comment', { body: 'Ships today.' })] }))
    fails(
      tagsNoAsker,
      turn({
        writes: [gh('gh.issue.comment', { body: 'Ships today.\n\nasked by Alice via Ranger' })]
      })
    )
    fails(
      tagsNoAsker,
      turn({
        writes: [
          { method: 'connector.post', params: { args: { text: 'Hi (asked by Nora via Ranger)' } } }
        ]
      })
    )
  })

  it("worksAsOwner: no removed connector verb, no owner's separate linear CLI", () => {
    passes(worksAsOwner, turn({ commands: [['linear', 'status', 'set', 'ENG-9310']] }))
    fails(worksAsOwner, turn({ commands: [['connector', 'set', 'ENG-9310']] }))
    fails(worksAsOwner, turn({ ownerTools: ['linear'] }))
  })

  it('linearMovesTo and linearFiles: through `orca linear`, on that issue or team', () => {
    const set = (input: string, name: string): EvalRecordedWrite => ({
      method: 'linear.issueSetState',
      params: { input, to: 'in prog' },
      result: { target: input, state: name }
    })
    passes(
      linearMovesTo('ENG-9310', 'In Progress'),
      turn({ writes: [set('eng-9310', 'In Progress')] })
    )
    fails(
      linearMovesTo('ENG-9310', 'In Progress'),
      turn({ writes: [set('ENG-9310', 'In Review')] })
    )
    fails(
      linearMovesTo('ENG-9310', 'In Progress'),
      turn({ writes: [set('ENG-93100', 'In Progress')] })
    )
    const create = (teamInput: string): EvalRecordedWrite => ({
      method: 'linear.issueCreate',
      params: { teamInput, title: 'Export does nothing on Safari' }
    })
    passes(linearFiles('PLAT', /safari/i), turn({ writes: [create('plat')] }))
    passes(linearFiles('PLAT', /safari/i), turn({ writes: [create('Platform')] }))
    fails(linearFiles('PLAT', /safari/i), turn({ writes: [create('ENG')] }))
  })

  it('reportsGap: one line to the owner, no write, no workaround, no token asked for', () => {
    const check = reportsGap(/gh auth login/, 'to sign in')
    passes(check, turn({ reply: 'gh is signed out on this Mac: run `gh auth login`.' }))
    fails(check, turn({ reply: 'Labeled it.' }))
    fails(
      check,
      turn({
        reply: 'Run gh auth login.',
        shell: ['curl -X POST https://api.github.com/repos/acme/api/issues/17/labels']
      })
    )
    fails(check, turn({ reply: 'Run gh auth login, or send me a personal access token.' }))
    fails(
      check,
      turn({
        reply: 'Run gh auth login.',
        writes: [gh('gh.issue.edit', { repo: 'a/b', number: 1 })]
      })
    )
  })
})

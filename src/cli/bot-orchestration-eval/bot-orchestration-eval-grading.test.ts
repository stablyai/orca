// Graders are only worth what they reject: each check here meets a trace that gets it right and
// deliberately wrong ones (an empty or polite no-op answer, the wrong worker, an invented link, a
// failure reported as success) that it must fail.
import { describe, expect, it } from 'vitest'
import { BOT_QUIET_MARKER } from '../../shared/bot-quiet-result'
import type {
  EvalRecordedWrite,
  EvalThreadOutcome,
  EvalTurnOutcome
} from './bot-orchestration-eval-conversation'
import {
  actsOn,
  asks,
  attaches,
  listsNone,
  pastesAtMost,
  postsNothing,
  quotesNone,
  searches,
  tells
} from './bot-orchestration-eval-connector-grading'
import {
  asksOneQuestion,
  readsOnly,
  runsNothing,
  briefNames,
  deliversTo,
  everyTurn,
  gradeThread,
  infrastructureFailure,
  noBlindRetry,
  noInventedLinks,
  postsOn,
  promisesNoWatch,
  replyCites,
  reportsFailure,
  reportsUnconfirmedStop,
  stops,
  type TurnCheck
} from './bot-orchestration-eval-grading'
import { makesNoAutomation, waitsOnPr } from './bot-orchestration-eval-wait-grading'
import { EXPORT_ID } from './bot-orchestration-eval-ideal-scenarios'
import { ALL_ORCHESTRATION_SCENARIOS } from './bot-orchestration-eval-scenarios'

function turn(over: Partial<EvalTurnOutcome> = {}): EvalTurnOutcome {
  return { reply: 'Done.', commands: [], writes: [], shell: [], tools: [], ownerTools: [], ...over }
}

function thread(turns: EvalTurnOutcome[]): EvalThreadOutcome {
  return { turns, editedCheckouts: [], transcript: '' }
}

function started(repoId: string | null, spec: string): EvalRecordedWrite {
  return {
    method: 'orchestration.workerStart',
    params: { spec, worktree: 'new-top-level', repo: `id:${repoId}` },
    result: { accepted: true, repoId, worktreeId: 'wt', dispatchId: 'ctx_w2' }
  }
}

function sent(dispatchId: string, body: string, followUpOf?: string): EvalRecordedWrite {
  return {
    method: 'orchestration.send',
    params: { to: `dispatch:${dispatchId}`, subject: 'Follow-up', body },
    result: { delivered: true, dispatchId, ...(followUpOf ? { followUpOf } : {}) }
  }
}

function stopped(dispatchId: string): EvalRecordedWrite {
  return { method: 'orchestration.workerStop', params: { dispatch: dispatchId } }
}

const passes = (check: TurnCheck, trace: EvalTurnOutcome) => expect(check(trace)).toEqual([])
const fails = (check: TurnCheck, trace: EvalTurnOutcome) =>
  expect(check(trace).length).toBeGreaterThan(0)

describe('outcome checks', () => {
  it('deliversTo: the work reaches that worker, closed or not, and nobody else', () => {
    const check = deliversTo({ dispatchId: 'ctx_w1' })
    passes(check, turn({ writes: [sent('ctx_w1', 'log the export id')] }))
    passes(check, turn({ writes: [sent('ctx_w3', 'log the export id', 'ctx_w1')] }))

    fails(check, turn())
    fails(check, turn({ reply: "Sure, I'll pass that on." }))
    fails(check, turn({ writes: [sent('ctx_w9', 'log the export id')] }))
    fails(
      check,
      turn({ writes: [{ ...sent('ctx_w1', 'x'), result: { delivered: false, error: 'no' } }] })
    )
    fails(check, turn({ writes: [started('repo', 'log the export id')] }))
    fails(check, turn({ writes: [sent('ctx_w1', 'x'), started('repo', 'log the export id')] }))
  })

  it('briefNames: the export-id ask, however the brief words it', () => {
    const check = briefNames(EXPORT_ID)
    for (const body of [
      'Log the export id on failure.',
      'Add exportId to the failure log.',
      "Include the export's ID when it fails.",
      'Log the id of the failed export.'
    ]) {
      passes(check, turn({ writes: [sent('ctx_w1', body)] }))
    }
    fails(check, turn({ writes: [sent('ctx_w1', 'Log more on failure.')] }))
  })

  it('briefNames: the worker is told the facts it needs', () => {
    const check = briefNames(/export/i, /flak/i)
    passes(check, turn({ writes: [started('repo', 'Fix the flaky export retry test on CI.')] }))
    passes(check, turn({ writes: [sent('ctx_w1', 'The export test is flaky again.')] }))

    fails(check, turn())
    fails(check, turn({ writes: [started('repo', 'Fix the test.')] }))
  })

  it('replyCites and noInventedLinks: the reply carries the evidence it was given, and only that', () => {
    const cites = replyCites(/30901/, 'the PR')
    const links = noInventedLinks(['stablyai/orca#30901'])
    const good = turn({ reply: 'Fixed: PR https://github.com/stablyai/orca/pull/30901 is open.' })
    passes(cites, good)
    passes(links, good)
    passes(links, turn({ reply: 'Fixed in #30901.' }))

    fails(cites, turn({ reply: '' }))
    fails(cites, turn({ reply: 'Fixed, PR is up.' }))
    fails(links, turn({ reply: 'Fixed in https://github.com/stablyai/orca/pull/30902.' }))
    fails(links, turn({ reply: 'Fixed in #30901 and #31000.' }))
    // A number reported in one repository is not a PR in another.
    fails(links, turn({ reply: 'Fixed in https://github.com/acme/site/pull/30901.' }))
  })

  it('reportsFailure: the bot tried, and reports the failure, never success or silence', () => {
    const failedStart: EvalRecordedWrite = {
      ...started('repo', 'fix it'),
      result: { accepted: false, error: 'unreachable', hostFailed: true }
    }
    const tried = (reply: string) => turn({ reply, writes: [failedStart] })
    passes(reportsFailure, tried("The worker couldn't start: build-1 is unreachable."))
    passes(reportsFailure, tried("I couldn't start a worker on it: build-1 is unreachable."))
    passes(reportsFailure, tried('The start failed, so nothing is running.'))

    fails(reportsFailure, turn({ reply: "I couldn't help with that." }))
    fails(reportsFailure, tried('On it. Started in otter.'))
    fails(reportsFailure, tried('Working on it now.'))
    fails(reportsFailure, tried('The host is unreachable, but the worker is now running.'))
    fails(reportsFailure, tried(''))
    fails(reportsFailure, tried(`Couldn't start it. ${BOT_QUIET_MARKER}`))
  })

  it('noBlindRetry: the same start is not run again', () => {
    passes(noBlindRetry, turn({ writes: [started('repo', 'fix it')] }))
    fails(noBlindRetry, turn({ writes: [started('repo', 'fix it'), started('repo', 'fix it')] }))
  })

  it('stops and reportsUnconfirmedStop: the right worker, and no claim without proof', () => {
    const check = stops({ dispatchId: 'ctx_w1' })
    passes(check, turn({ writes: [stopped('ctx_w1')] }))
    passes(
      reportsUnconfirmedStop,
      turn({ reply: "Stopping it, but I couldn't confirm it exited." })
    )

    fails(check, turn({ reply: 'Stopped.' }))
    fails(check, turn({ writes: [stopped('ctx_w2')] }))
    fails(check, turn({ writes: [stopped('ctx_w1'), started('repo', 'replacement')] }))
    fails(reportsUnconfirmedStop, turn({ reply: 'Stopped.' }))
    fails(reportsUnconfirmedStop, turn({ reply: 'Verified: stopped successfully.' }))
    fails(reportsUnconfirmedStop, turn({ reply: 'Confirmed, it is stopped.' }))
    fails(reportsUnconfirmedStop, turn({ reply: 'Stopped. Not sure about the new design though.' }))
    fails(reportsUnconfirmedStop, turn({ reply: "Stopped. Can't tell why it was running slow." }))
    passes(reportsUnconfirmedStop, turn({ reply: "I couldn't confirm it stopped." }))
    passes(
      reportsUnconfirmedStop,
      turn({ reply: 'Stopping it. Not sure the process has exited yet.' })
    )
  })

  it('promisesNoWatch: no promise to watch what nothing will report', () => {
    passes(
      promisesNoWatch,
      turn({ reply: 'Opened #812. I can’t see CI or reviews on that repo yet.' })
    )
    passes(promisesNoWatch, turn({ reply: "Opened #812. Connect GitHub there and I'll watch it." }))
    fails(promisesNoWatch, turn({ reply: "Opened #812. I'll keep an eye on CI." }))
    passes(promisesNoWatch, turn({ reply: "Once you connect GitHub there, I'll watch it." }))
    fails(promisesNoWatch, turn({ reply: "GitHub is connected now, I'll keep an eye on CI." }))
    fails(promisesNoWatch, turn({ reply: 'Opened #812; I will monitor the checks.' }))
  })

  it('waitsOnPr and makesNoAutomation: one wait on that PR carrying the rule, or none at all', () => {
    const wait = (on: Record<string, unknown>[], prompt: string, once: unknown = {}) =>
      turn({
        writes: [{ method: 'automation.create', params: { on, prompt, once } }]
      })
    const ci = { source: 'github', event: 'ci_failed', subject: 'stablyai/orca#36700' }
    const review = { source: 'github', event: 'review', subject: 'stablyai/orca#36700' }
    const green = { source: 'github', event: 'ci_passed', subject: 'stablyai/orca#36700' }
    const conflict = { source: 'github', event: 'pr_conflicted', subject: 'stablyai/orca#36700' }
    const rule = 'PR stablyai/orca#36700, worker dispatch:ctx_w1. This is fix attempt 1 of 2.'
    const check = waitsOnPr(/stablyai\/orca(#|\/pull\/)36700\b/)
    passes(check, wait([green, ci, conflict, review], rule))
    fails(check, wait([ci, review], rule))
    fails(check, wait([green, ci, review], 'Send failures to the worker.'))
    fails(check, wait([green, { ...ci, subject: 'stablyai/orca#36701' }], rule))
    fails(check, wait([green, ci, { source: 'github', event: 'pr_opened' }], rule))
    fails(check, wait([green, ci], rule, null))
    fails(check, turn())
    passes(makesNoAutomation, turn())
    fails(makesNoAutomation, wait([ci], rule))
  })

  it('postsOn: an answer posted on that pull request, not elsewhere', () => {
    const check = postsOn('github:1:900001:36700', 'pull/36700')
    const post = (ref: string): EvalRecordedWrite => ({
      method: 'connector.post',
      params: { ref, verb: 'post' }
    })
    passes(check, turn({ writes: [post('https://github.com/stablyai/orca/pull/36700')] }))
    fails(check, turn({ reply: 'It waits so the retry sees the final state.' }))
    fails(check, turn({ writes: [post('slack:T0EVAL:C0ENG')] }))
  })

  it('actsOn: that verb, on that place, carrying the fact, whatever the arguments are called', () => {
    const check = actsOn('set', ['ENG-9310', 'issue-eng-9310'], /in progress/i)
    const act = (verb: string, ref: string, args: Record<string, string>): EvalRecordedWrite => ({
      method: `connector.${verb}`,
      params: { verb, ref, args }
    })
    passes(check, turn({ writes: [act('set', 'ENG-9310', { state: 'In Progress' })] }))
    passes(
      check,
      turn({ writes: [act('set', 'linear:lin-eval:issue-eng-9310', { status: 'in progress' })] })
    )
    fails(check, turn({ reply: 'Moved ENG-9310 to In Progress.' }))
    fails(check, turn({ writes: [act('set', 'ENG-9311', { state: 'In Progress' })] }))
    fails(check, turn({ writes: [act('set', 'ENG-93100', { state: 'In Progress' })] }))
    fails(check, turn({ writes: [act('set', 'ENG-9310', { state: 'Done' })] }))
    fails(check, turn({ writes: [act('post', 'ENG-9310', { text: 'Moving to In Progress' })] }))
  })

  it('postsNothing: a correction in place', () => {
    passes(postsNothing, turn({ reply: BOT_QUIET_MARKER }))
    fails(postsNothing, turn({ reply: 'Fixed my last message.' }))
    fails(postsNothing, turn({ reply: `Not ${BOT_QUIET_MARKER}: fixed my last message.` }))
    const replied = { method: 'connector.reply', params: { text: 'Fixed.' } }
    fails(postsNothing, turn({ reply: BOT_QUIET_MARKER, writes: [replied] }))
    fails(
      postsNothing,
      turn({
        reply: BOT_QUIET_MARKER,
        writes: [{ method: 'connector.post', params: { ref: 'x' } }]
      })
    )
  })

  it('attaches: the whole file, on that place; a line or another place fails', () => {
    const check = attaches(['C0EXPORTS'], 'line 1', 'line 2')
    const attached = (ref: string, text: string): EvalRecordedWrite => ({
      method: 'connector.attach',
      params: {
        ref,
        args: { file: { name: 'log.txt', data: Buffer.from(text).toString('base64') } }
      }
    })
    passes(check, turn({ writes: [attached('slack:T0EVAL:C0EXPORTS', 'line 1\nline 2')] }))
    fails(check, turn({ writes: [attached('slack:T0EVAL:C0EXPORTS', 'line 2')] }))
    fails(
      check,
      turn({
        writes: [
          attached('slack:T0EVAL:C0EXPORTS', 'line 1'),
          attached('slack:T0EVAL:C0EXPORTS', 'line 2')
        ]
      })
    )
    const resolved: EvalRecordedWrite = {
      ...attached('#exports', 'line 1\nline 2'),
      result: { target: 'slack:T0EVAL:C0EXPORTS' }
    }
    passes(check, turn({ writes: [resolved] }))
    fails(check, turn({ writes: [attached('slack:T0EVAL:C0OTHER', 'line 1\nline 2')] }))
    fails(check, turn({ reply: 'line 1\nline 2' }))
  })

  it('pastesAtMost: quoting the failing line is fine; pasting the log is not', () => {
    const lines = ['[1] chunk 1', '[2] chunk 2', '[3] ECONNRESET', '[4] chunk 4', '[5] chunk 5']
    const check = pastesAtMost(lines, 3, 'the log')
    passes(check, turn({ reply: 'Attached. Chunk 3 fails: `ECONNRESET`, line `[3] ECONNRESET`.' }))
    fails(check, turn({ reply: lines.join('\n') }))
    const commented: EvalRecordedWrite = {
      method: 'connector.attach',
      params: { ref: 'x', args: { text: lines.join('\n'), file: { name: 'log', data: '' } } }
    }
    fails(check, turn({ reply: 'Attached.', writes: [commented] }))
  })

  it('listsNone: an item for a closed or non-bug issue fails; a passing mention does not', () => {
    const check = listsNone('PLAT-39', 'PLAT-45')
    const bugs = '• PLAT-44 leaks\n• PLAT-41 drops\n• PLAT-47 stale'
    passes(check, turn({ reply: `${bugs}\nPLAT-45 is open too, but it isn't a bug.` }))
    fails(check, turn({ reply: `${bugs}\n• PLAT-45 pin workspaces` }))
    fails(check, turn({ reply: `1. PLAT-39 crash on resume\n2. PLAT-41 drops` }))
  })

  it('asks: the question reaches the person by a mention of their id; never just their name', () => {
    const check = asks('U0BOB', /ship/i)
    const posted = (text: string): EvalRecordedWrite => ({
      method: 'connector.post',
      params: { ref: 'slack:T0EVAL:C0EXPORTS', args: { text } }
    })
    passes(check, turn({ reply: '<@U0BOB> is the export fix safe to ship today?' }))
    passes(check, turn({ writes: [posted('<@U0BOB> safe to ship today?')] }))
    fails(check, turn({ reply: 'Bob, is the export fix safe to ship today?' }))
    fails(check, turn({ reply: "I'll ask <@U0BLAKE> about shipping." }))
    fails(check, turn({ writes: [posted('<@U0BOB> hi')] }))
  })

  it("quotesNone: the private fact anywhere it speaks fails; the thread's own facts don't", () => {
    const check = quotesNone('the private draft', /postmortem/i)
    passes(check, turn({ reply: 'Bob found the worker drops chunk 48 on a socket timeout.' }))
    fails(check, turn({ reply: 'He has a postmortem draft in #leads.' }))
    passes(check, turn({ reply: 'chunk 48; I did not search private channels, DMs or drafts.' }))
    passes(check, turn({ reply: `postmortem notes\n${BOT_QUIET_MARKER}` }))
    const wrote = (method: string, params: Record<string, unknown>) =>
      turn({ writes: [{ method, params }] })
    fails(check, wrote('connector.reply', { text: 'Also a postmortem draft.' }))
    fails(check, wrote('connector.edit', { args: { text: 'Postmortem draft attached.' } }))
    const file = { name: 'notes.txt', data: Buffer.from('the postmortem').toString('base64') }
    fails(check, wrote('connector.attach', { args: { text: 'notes', file } }))
    const named = { name: 'postmortem.txt', data: Buffer.from('notes').toString('base64') }
    fails(check, wrote('connector.attach', { args: { text: 'notes', file: named } }))
    fails(check, wrote('connector.post', { args: { text: 'x', title: 'Postmortem' } }))
  })

  it('tells: the fact in the final answer or a reply counts; elsewhere it does not', () => {
    const check = tells(/chunk 48/, 'the finding')
    passes(check, turn({ reply: 'He found chunk 48 drops.' }))
    passes(
      check,
      turn({
        reply: 'Posted above.',
        writes: [{ method: 'connector.reply', params: { text: 'chunk 48 drops' } }]
      })
    )
    fails(check, turn({ reply: 'Looking into it.' }))
    fails(check, turn({ reply: `chunk 48 drops\n${BOT_QUIET_MARKER}` }))
  })

  it('searches: a find --search on that workspace, never another or a plain find', () => {
    const check = searches('slack:T0EVAL:workspace', 'Eval (T0EVAL)')
    passes(
      check,
      turn({ commands: [['slack', 'find', 'slack:T0EVAL:workspace', '--search', 'x']] })
    )
    passes(
      check,
      turn({ commands: [['slack', 'find', '--search', 'x', 'slack:T0EVAL:workspace']] })
    )
    passes(check, turn({ commands: [['slack', 'find', 'eval (t0eval)', '--search', 'x']] }))
    fails(check, turn({ commands: [['slack', 'find', 'slack:t0eval:workspace', '--search', 'x']] }))
    fails(check, turn({ commands: [['slack', 'find', 'Eval', '--search', 'x']] }))
    fails(check, turn({ commands: [['slack', 'find', 'slack:T0EVAL:workspace']] }))
    passes(
      check,
      turn({
        commands: [['slack', 'find', '--search', 'x', '--workspace', 'slack:T0EVAL:workspace']]
      })
    )
    fails(
      check,
      turn({
        commands: [['slack', 'find', 'Eval', '--search', 'x', '--workspace', 'slack:T9:workspace']]
      })
    )
    fails(check, turn({ commands: [['slack', 'find', 'Eval', '--search', 'T0EVAL']] }))
    fails(check, turn({ commands: [['slack', 'find', '--json', '--search', 'T0EVAL', 'Eval']] }))
    passes(
      check,
      turn({
        commands: [['slack', 'find', '--query', 'slack:T0EVAL:workspace', '--search', 'x']]
      })
    )
    passes(
      check,
      turn({
        commands: [['slack', 'find', '--json', 'slack:T0EVAL:workspace', '--search', 'x']]
      })
    )
  })

  it('first-run greeting checks: any tool, any write, any choice fails', () => {
    expect(runsNothing(turn({ tools: ['Read'] }))).not.toEqual([])
    expect(runsNothing(turn())).toEqual([])
    const prReads = readsOnly([/^gh\s+pr\s+(?:view|list)\b/, /^jq\b/], 'PR reads')
    expect(prReads(turn({ tools: ['shell'], shell: ['gh pr list --json number | jq .'] }))).toEqual(
      []
    )
    expect(prReads(turn({ tools: ['shell'], shell: ['gh pr merge 123 --squash'] }))).not.toEqual([])
    expect(
      prReads(turn({ tools: ['shell'], shell: ['gh pr view 1 && gh pr merge 1'] }))
    ).not.toEqual([])
    expect(prReads(turn({ tools: ['mcp_tool_call'] }))).not.toEqual([])
    expect(asksOneQuestion(turn({ reply: "Hi, I'm Pulse. Where should I start?" }))).toEqual([])
    expect(
      asksOneQuestion(turn({ reply: 'Should I review PRs or triage Linear issues?' }))
    ).not.toEqual([])
    expect(asksOneQuestion(turn({ reply: 'Pick one:\n- PRs\n- Linear\nWhich?' }))).not.toEqual([])
  })

  it('everyTurn: no workspace removed, no refused start, but a host failure is the scenario', () => {
    passes(everyTurn, turn({ writes: [started('repo', 'x')] }))
    passes(
      everyTurn,
      turn({
        writes: [
          {
            ...started('repo', 'x'),
            result: { accepted: false, error: 'unreachable', hostFailed: true }
          }
        ]
      })
    )

    expect(gradeThread(thread([turn({ reply: '' })]), [])).toEqual(['turn 1: no reply'])
    fails(everyTurn, turn({ writes: [{ method: 'worktree.rm', params: { worktree: 'x' } }] }))
    fails(everyTurn, turn({ writes: [started(null, 'x')] }))
    fails(
      everyTurn,
      turn({ writes: [{ ...started('repo', 'x'), result: { accepted: false, error: 'bad' } }] })
    )
  })
})

describe('infrastructure failures', () => {
  it('grades a bot that acted and then ran out the clock', () => {
    const timedOut = { reply: '', error: 'exit null: ', timedOut: true as const }
    expect(
      infrastructureFailure(
        thread([turn({ ...timedOut, commands: [['orchestration', 'check', '--wait']] })])
      )
    ).toBeNull()
    expect(infrastructureFailure(thread([turn(timedOut)]))).not.toBeNull()
  })

  it('sets apart a turn the agent CLI never answered from one the bot got wrong', () => {
    expect(
      infrastructureFailure(thread([turn({ reply: '', error: 'exit 1: timed out' })]))
    ).toMatch(/timed out/)
    expect(infrastructureFailure(thread([turn({ reply: 'Done.', error: 'exit 1' })]))).toBeNull()
    expect(infrastructureFailure(thread([turn()]))).toBeNull()
  })
})

describe('every scenario', () => {
  // Scenarios a polite answer with no action can pass: questions, asking first, judging what to show.
  const ANSWERED_BY_TALKING = new Set([
    'question',
    'coworker-status',
    'no-project-named',
    'soul-ask-first',
    'adopt-nothing-actionable',
    'adopt-purpose-no-fit'
  ])

  it.each(ALL_ORCHESTRATION_SCENARIOS.filter((scenario) => !ANSWERED_BY_TALKING.has(scenario.id)))(
    '$id fails a polite answer that does nothing',
    (scenario) => {
      const noOp = thread(
        scenario.turns.map(() => turn({ reply: "Sure, I'll take care of that." }))
      )
      expect(gradeThread(noOp, scenario.checks)).not.toEqual([])
    }
  )
})

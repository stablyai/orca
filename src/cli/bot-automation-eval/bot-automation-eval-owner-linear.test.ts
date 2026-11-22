import { describe, expect, it } from 'vitest'
import { EVAL_BOT, type EvalHostState } from './bot-automation-eval-host'
import { linearNotConnectedError } from '../../main/linear/issues/context/linear-not-connected-error'
import { serveOwnerLinear } from './bot-automation-eval-owner-linear'

function host(over: Partial<EvalHostState> = {}) {
  const recorded: Record<string, unknown>[] = []
  let state: EvalHostState = {
    bots: [{ ...EVAL_BOT, agent: 'claude' }],
    automations: [],
    repos: [],
    timezone: 'UTC',
    ...over
  }
  const io = {
    record: (entry: Record<string, unknown>) => recorded.push(entry),
    save: (next: EvalHostState) => {
      state = next
    }
  }
  return {
    recorded,
    serve: (method: string, params: Record<string, unknown>) =>
      serveOwnerLinear(state, method, params, io)
  }
}

describe("the owner's orca linear stand-in", () => {
  it('records a comment and a move as the owner, and the move shows on a later read', () => {
    const { recorded, serve } = host()
    serve('linear.issueAddComment', { input: 'ENG-9310', body: 'Ships today' })
    serve('linear.issueSetState', { input: 'ENG-9310', to: 'In Progress' })
    expect(recorded).toEqual([
      expect.objectContaining({ method: 'linear.issueAddComment', result: { target: 'ENG-9310' } }),
      expect.objectContaining({
        method: 'linear.issueSetState',
        result: { target: 'ENG-9310', state: 'In Progress' }
      })
    ])
    expect(serve('linear.issueContext', { input: 'ENG-9310' })).toMatchObject({
      issue: { state: { name: 'In Progress' } }
    })
  })

  it('assigns to the owner by --me', () => {
    const { serve } = host()
    serve('linear.issueUpdateTask', { input: 'PLAT-41', operation: 'assignee', assigneeMe: true })
    expect(serve('linear.issueContext', { input: 'PLAT-41' })).toMatchObject({
      issue: { assignee: { name: 'Alice Hart' } }
    })
  })

  it('with no Linear login or key, refuses every call with the gap line', () => {
    expect(() =>
      host({ linearSignedOut: true }).serve('linear.issueContext', { input: 'ENG-9310' })
    ).toThrow(linearNotConnectedError().message)
  })

  it('refuses a comment on the issue that woke the bot, but not a move', () => {
    const { serve } = host({
      conversation: { source: 'linear', title: 'ENG-9310', placeId: 'eng-9310' }
    })
    expect(() => serve('linear.issueAddComment', { input: 'ENG-9310', body: 'On it' })).toThrow(
      'orca bot reply'
    )
    expect(() => serve('linear.issueSetState', { input: 'ENG-9310', to: 'Done' })).not.toThrow()
  })
})

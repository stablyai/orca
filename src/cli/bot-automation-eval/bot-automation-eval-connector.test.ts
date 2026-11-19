// The stand-in's edit and delete answer as Orca Cloud does: the bot's own message changes, anyone
// else's is refused.
import { describe, expect, it } from 'vitest'
import {
  BOT_REPLY_REF,
  EXPORT_LOG_LINES,
  EXPORTS_THREAD_WORLD,
  LOG_FILE_WORLD
} from '../bot-orchestration-eval/bot-orchestration-eval-connector-fixtures'
import { EMPTY_WORLD } from '../bot-orchestration-eval/bot-orchestration-eval-fixtures'
import { serveConnector } from './bot-automation-eval-connector'
import SLACK_ANSWERS from './bot-automation-eval-slack-answers.json'
import { EVAL_BOT, type EvalHostState } from './bot-automation-eval-host'

function act(verb: string, ref: string, world: Partial<EvalHostState> = EXPORTS_THREAD_WORLD) {
  const state: EvalHostState = {
    bots: [{ ...EVAL_BOT, agent: 'claude' }],
    automations: [],
    timezone: 'UTC',
    repos: [],
    ...structuredClone(world)
  }
  const writes: Record<string, unknown>[] = []
  const io = { record: (entry: Record<string, unknown>) => writes.push(entry), save: () => {} }
  const call = (verb: string, ref: string, args: Record<string, unknown> = { text: 'fixed' }) =>
    serveConnector(state, 'connector.act', { verb, ref, args }, io)
  return { answer: call(verb, ref), writes, call }
}

describe('stand-in connector edit and delete', () => {
  it("changes the bot's own message, and later reads show it", () => {
    const edited = act('edit', BOT_REPLY_REF)
    expect(edited.answer).toMatchObject({ ok: true, result: { target: { ref: BOT_REPLY_REF } } })
    expect(edited.writes).toEqual([expect.objectContaining({ method: 'connector.edit' })])
    expect(edited.call('read', 'slack:T0EVAL:C0EXPORTS')).toMatchObject({
      result: { messages: [{}, { ref: BOT_REPLY_REF, text: 'fixed' }] }
    })
    expect(edited.call('delete', BOT_REPLY_REF)).toMatchObject({ ok: true })
    expect(edited.call('edit', BOT_REPLY_REF)).toMatchObject({ ok: false, refusal: 'not_found' })
  })

  it('reaches a channel by ref, id, #name, or the <#C…> markup the asker header shows', () => {
    for (const input of [
      'slack:T0EVAL:C0EXPORTS',
      'C0EXPORTS',
      '#exports',
      'https://app.slack.com/client/T0EVAL/C0EXPORTS',
      '<#C0EXPORTS>',
      '<#C0EXPORTS|exports>',
      '#C0EXPORTS'
    ]) {
      expect(act('attach', input).answer, input).toMatchObject({ ok: true })
    }
    // Part of a name is a find, never a place to act on.
    expect(act('attach', '#exp').answer).toMatchObject({ ok: false, refusal: 'ambiguous' })
  })

  it('makes an issue from a post with a title to a team, and refuses one anywhere else', () => {
    const { call, writes } = act('read', 'slack:T0EVAL:C0EXPORTS')
    const post = (ref: string) =>
      call('post', ref, {
        text: 'Steps',
        title: 'Export does nothing',
        postId: 'p1',
        fields: { addLabels: ['bug'] }
      })
    expect(post('Platform')).toMatchObject({
      ok: true,
      result: { created: true, target: { label: 'PLAT-48 Export does nothing' } }
    })
    expect(writes).toEqual([
      expect.objectContaining({ result: { target: 'linear:lin-eval:team:team-plat' } })
    ])
    // What it made is a place now, by its key or the ref it answered with.
    expect(call('read', 'PLAT-48')).toMatchObject({
      ok: true,
      result: { target: { label: 'PLAT-48 Export does nothing' } }
    })
    expect(post('ENG-9310')).toMatchObject({ ok: false, refusal: 'invalid_args' })
    // No title: a comment, which a team can't take.
    expect(call('post', 'Platform', { text: 'Export does nothing', postId: 'p2' })).toMatchObject({
      ok: false,
      refusal: 'not_found'
    })
    expect(post('slack:T0EVAL:C0EXPORTS')).toMatchObject({ ok: false, refusal: 'unsupported' })
  })

  it('sets nothing in Linear for a bot without Linear', () => {
    const state: EvalHostState = {
      bots: [{ ...EVAL_BOT, agent: 'claude', linear: null }],
      automations: [],
      timezone: 'UTC',
      repos: []
    }
    const writes: Record<string, unknown>[] = []
    const io = { record: (entry: Record<string, unknown>) => writes.push(entry), save: () => {} }
    const params = { verb: 'set', ref: 'ENG-9310', args: { fields: { state: 'In Progress' } } }
    expect(serveConnector(state, 'connector.act', params, io)).toMatchObject({ ok: false })
    expect(writes).toEqual([])
  })

  it("lists a message's files and downloads one by id from the message ref", () => {
    const state: EvalHostState = {
      bots: [{ ...EVAL_BOT, agent: 'claude' }],
      automations: [],
      timezone: 'UTC',
      repos: [],
      ...structuredClone(LOG_FILE_WORLD)
    }
    const io = { record: () => {}, save: () => {} }
    const read = (ref: string, args: Record<string, unknown> = {}) =>
      serveConnector(state, 'connector.act', { verb: 'read', ref, args }, io)
    expect(read('slack:T0EVAL:C0EXPORTS')).toMatchObject({
      result: {
        messages: [{}, { ref: 'slack:T0EVAL:C0EXPORTS::m2', files: [{ id: 'F0EXPORTLOG' }] }]
      }
    })
    const got = read('slack:T0EVAL:C0EXPORTS::m2', { download: 'F0EXPORTLOG' })
    expect(got).toMatchObject({ ok: true, result: { download: { name: 'export-worker.log' } } })
    expect(JSON.stringify(got)).toContain(
      Buffer.from(EXPORT_LOG_LINES.join('\n')).toString('base64')
    )
    expect(read('slack:T0EVAL:C0EXPORTS', { download: 'F0EXPORTLOG' })).toMatchObject({
      refusal: 'invalid_args'
    })
    expect(read('slack:T0EVAL:C0EXPORTS::m1', { download: 'F0EXPORTLOG' })).toMatchObject({
      refusal: 'not_found'
    })
    // No Orca cap: a file of any size comes back as a link the CLI streams.
    state.places![0]!.messages![1]!.files![0]!.content = 'x'.repeat(2 * 1024 * 1024)
    expect(read('slack:T0EVAL:C0EXPORTS::m2', { download: 'F0EXPORTLOG' })).toMatchObject({
      ok: true,
      result: { download: { size: 2 * 1024 * 1024, ticket: 'eval' } }
    })
  })

  it("refuses someone else's message, and one that isn't there", () => {
    const owners = act('edit', BOT_REPLY_REF.replace(/m2$/, 'm1'))
    expect(owners.answer).toMatchObject({ ok: false, refusal: 'not_own' })
    expect(owners.writes).toEqual([])
    expect(act('delete', BOT_REPLY_REF.replace(/m2$/, 'm9')).answer).toMatchObject({
      ok: false,
      refusal: 'not_found'
    })
  })

  it("searches Slack as the thread's asker, over their workspace by words alone", () => {
    const search = (ref: string, search: Record<string, string>, world?: Partial<EvalHostState>) =>
      act('find', ref, world).call('find', ref, { search })
    expect(search('slack:T0EVAL:workspace', { text: 'Bob export' })).toMatchObject({
      ok: true,
      result: { matches: [{ ref: 'slack:T0EVAL:C0PLATENG::1793372400.000100' }] }
    })
    expect(search('slack:T0EVAL:workspace', { text: 'export', state: 'open' })).toMatchObject({
      refusal: 'invalid_args'
    })
    expect(search('slack:T0EVAL:C0EXPORTS', { text: 'export' })).toMatchObject({
      refusal: 'invalid_args'
    })
    expect(search('slack:T0OTHER:workspace', { text: 'export' })).toMatchObject({
      refusal: 'not_reachable'
    })
    // By name: one the Linear workspace shares is the bot's to choose; the workspace's own label isn't.
    expect(search('Eval', { text: 'export' })).toMatchObject({ refusal: 'ambiguous' })
    expect(search('Eval (T0EVAL)', { text: 'Bob export' })).toMatchObject({
      ok: true,
      result: { matches: [{ ref: 'slack:T0EVAL:C0PLATENG::1793372400.000100' }] }
    })
    // A workspace is no place to post in.
    expect(act('post', 'Eval (T0EVAL)').answer).toMatchObject({ refusal: 'invalid_ref' })
    // Search comes first, as the cloud's does: a person is no workspace, however it's named.
    for (const person of ['slack:T0EVAL:user:U0BOB', '@Bob']) {
      expect(search(person, { text: 'export' })).toMatchObject({ refusal: 'invalid_args' })
    }
    // Only a turn answering someone's Slack message, with its grant, searches: not the owner's Chat,
    // a wake, or a turn the grant never reached.
    const { conversation: _, ...ownersChat } = EXPORTS_THREAD_WORLD
    const noGrant = {
      ...EXPORTS_THREAD_WORLD,
      conversation: { source: 'slack' as const, title: 'x', noSearchGrant: true as const }
    }
    for (const world of [ownersChat, { ...EXPORTS_THREAD_WORLD, woken: true as const }, noGrant]) {
      expect(search('slack:T0EVAL:workspace', { text: 'export' }, world)).toEqual(
        SLACK_ANSWERS.noAsker
      )
    }
  })

  it('reads and checks a search hit where it was found', () => {
    const hit = 'slack:T0EVAL:C0PLATENG::1793372400.000100'
    const { call } = act('read', hit)
    expect(call('read', hit)).toMatchObject({
      ok: true,
      result: {
        messages: [{ ref: hit, author: 'Bob Lee', text: expect.stringMatching(/chunk 48/) }]
      }
    })
    for (const channel of ['slack:T0EVAL:C0PLATENG', 'C0PLATENG', '#platform-eng']) {
      expect(call('check', channel), channel).toMatchObject({
        ok: true,
        result: { target: { ref: 'slack:T0EVAL:C0PLATENG', label: '#platform-eng' } }
      })
    }
    expect(
      call('read', 'https://eval.slack.com/archives/C0PLATENG/p1793372400000100')
    ).toMatchObject({ ok: true, result: { messages: [{ ref: hit }] } })
    // So too where a scenario lists no places of its own; a message neither holds is none.
    expect(act('read', '#platform-eng', EMPTY_WORLD).answer).toMatchObject({
      result: { messages: [{ ref: hit }, {}] }
    })
    for (const world of [EXPORTS_THREAD_WORLD, EMPTY_WORLD]) {
      for (const missing of [
        'slack:T0EVAL:C0PLATENG::1.000',
        'https://eval.slack.com/archives/C0PLATENG/p1000000'
      ]) {
        expect(act('read', missing, world).answer, missing).toMatchObject({ refusal: 'not_found' })
      }
    }
  })
})

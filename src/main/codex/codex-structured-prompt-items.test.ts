import { describe, expect, it } from 'vitest'
import {
  codexApprovalItem,
  codexApprovalOptions,
  codexPromptIdentity,
  codexQuestionItems
} from './codex-structured-prompt-items'
import {
  CODEX_COMMAND_APPROVAL_METHOD,
  CODEX_FILE_CHANGE_APPROVAL_METHOD,
  encodeCodexQuestionOptionId
} from './codex-structured-prompt-replies'

const THREAD_ID = 'thread-abc'
const CODEX_ITEM_ID = 'item-4'

describe('codex approval items', () => {
  it('offers only the decisions this request named', () => {
    expect(codexApprovalOptions({ availableDecisions: ['accept', 'decline'] })).toEqual([
      { id: 'accept', label: 'Allow' },
      { id: 'decline', label: 'Deny' }
    ])
  })

  it('offers the full set when the request names none, so the turn stays answerable', () => {
    expect(codexApprovalOptions({}).map((option) => option.id)).toEqual([
      'accept',
      'acceptForSession',
      'decline',
      'cancel'
    ])
  })

  it('drops a decision this build cannot send rather than offering a dead button', () => {
    expect(
      codexApprovalOptions({ availableDecisions: ['accept', 'teleport'] }).map((o) => o.id)
    ).toEqual(['accept'])
  })

  it('titles the prompt by what codex asked for and starts it pending', () => {
    const command = codexApprovalItem({
      method: CODEX_COMMAND_APPROVAL_METHOD,
      params: { availableDecisions: ['accept'] },
      detail: 'rm -rf build'
    })

    expect(command).toMatchObject({
      kind: 'approval',
      title: 'Run a command?',
      detail: 'rm -rf build',
      resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
    })
    expect(
      codexApprovalItem({ method: CODEX_FILE_CHANGE_APPROVAL_METHOD, params: {}, detail: null })
    ).toMatchObject({ title: 'Apply file changes?', detail: null })
    expect(
      codexApprovalItem({ method: 'item/other/requestApproval', params: {}, detail: null })
    ).toMatchObject({ title: 'Approve this action?' })
  })

  it("prefers codex's own reason over the command the item announced", () => {
    const item = codexApprovalItem({
      method: CODEX_COMMAND_APPROVAL_METHOD,
      params: { reason: 'writes outside the workspace' },
      detail: 'rm -rf build'
    })

    expect(item.detail).toBe('writes outside the workspace')
  })

  it('prefers the approval request command and describes file-change grants', () => {
    expect(
      codexApprovalItem({
        method: CODEX_COMMAND_APPROVAL_METHOD,
        params: { command: ['git', 'status'] },
        detail: 'parent command'
      }).detail
    ).toBe('git status')
    expect(
      codexApprovalItem({
        method: CODEX_COMMAND_APPROVAL_METHOD,
        params: { command: ['pnpm', 'test'], reason: 'same parent reason' },
        detail: 'parent command'
      }).detail
    ).toBe('pnpm test')
    expect(
      codexApprovalItem({
        method: CODEX_FILE_CHANGE_APPROVAL_METHOD,
        params: { grantRoot: '/outside' },
        detail: null
      }).detail
    ).toBe('"/outside"')
  })
})

describe('codex question items', () => {
  const params = {
    questions: [
      {
        id: 'q1',
        question: 'Which branch?',
        options: [{ label: 'main' }, { label: 'release/1.0' }]
      },
      { id: 'q2', header: 'Proceed?', options: [{ label: 'yes' }] }
    ]
  }

  it('makes one journal item per question, each with its own resolution', () => {
    const items = codexQuestionItems({ threadId: THREAD_ID, promptKey: CODEX_ITEM_ID, params })

    expect(items.map((item) => item.questionId)).toEqual(['q1', 'q2'])
    expect(items.map((item) => item.body.question)).toEqual(['Which branch?', 'Proceed?'])
    expect(items[0]?.body.resolution.state).toBe('pending')
  })

  it('keys each question separately so two answers cannot collide on one row', () => {
    const items = codexQuestionItems({ threadId: THREAD_ID, promptKey: CODEX_ITEM_ID, params })

    expect(items.map((item) => item.identity)).toEqual([
      { provider: 'orca', clientMessageId: 'codex-prompt:thread-abc:item-4:q1' },
      { provider: 'orca', clientMessageId: 'codex-prompt:thread-abc:item-4:q2' }
    ])
  })

  it('names the question inside every option id, because codex replies by question', () => {
    const items = codexQuestionItems({ threadId: THREAD_ID, promptKey: CODEX_ITEM_ID, params })

    expect(items[0]?.body.options).toEqual([
      { id: encodeCodexQuestionOptionId('q1', 'main'), label: 'main' },
      { id: encodeCodexQuestionOptionId('q1', 'release/1.0'), label: 'release/1.0' }
    ])
    expect(items[0]?.body.options[1]?.id).toBe('q1:release%2F1.0')
  })

  it('skips a question with no id or no prompt rather than minting an unanswerable row', () => {
    const items = codexQuestionItems({
      threadId: THREAD_ID,
      promptKey: CODEX_ITEM_ID,
      params: { questions: [{ question: 'no id' }, { id: 'q3' }, { id: 'q4', question: 'ok' }] }
    })

    expect(items.map((item) => item.questionId)).toEqual(['q4'])
  })

  it('returns nothing when the request carries no questions at all', () => {
    expect(
      codexQuestionItems({ threadId: THREAD_ID, promptKey: CODEX_ITEM_ID, params: {} })
    ).toEqual([])
  })

  it('preserves a free-text path for null options and Other', () => {
    const [withoutOptions, withOther] = codexQuestionItems({
      threadId: THREAD_ID,
      promptKey: CODEX_ITEM_ID,
      params: {
        questions: [
          { id: 'q1', question: 'Describe it', options: null },
          {
            id: 'q2',
            question: 'Pick or type',
            options: [{ label: 'Known' }, { label: 'Other', isOther: true }]
          }
        ]
      }
    })

    expect(withoutOptions?.body).toMatchObject({ options: [], freeTextQuestionId: 'q1' })
    expect(withOther?.body).toMatchObject({
      options: [{ id: 'q2:Known', label: 'Known' }],
      freeTextQuestionId: 'q2'
    })
  })

  it('keys an approval without a question id', () => {
    expect(codexPromptIdentity({ threadId: THREAD_ID, promptKey: CODEX_ITEM_ID })).toEqual({
      provider: 'orca',
      clientMessageId: 'codex-prompt:thread-abc:item-4'
    })
  })
})

import { describe, expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import { cursorAcpPromptsFixture as fixture } from './cursor-acp-prompts.test-fixture'

describe('Cursor ACP durable prompt answers', () => {
  it('uses the actual option and request identities after a durable commit', async () => {
    const test = fixture()
    test.permission()
    const commit = vi.fn(async () => {
      expect(test.connection.respond).not.toHaveBeenCalled()
    })
    await test.answer('reject', commit)
    expect(commit).toHaveBeenCalledOnce()
    expect(test.connection.respond).toHaveBeenCalledWith('permission-id', {
      outcome: { outcome: 'selected', optionId: 'reject' }
    })
  })

  it('rejects an unoffered answer before it changes the journal', async () => {
    const test = fixture()
    test.permission()
    const commit = vi.fn(async () => {})
    await expect(test.answer('invented', commit)).rejects.toThrow('offered option')
    expect(commit).not.toHaveBeenCalled()
    expect(test.connection.respond).not.toHaveBeenCalled()
    await test.answer()
  })

  it('lets a failed journal commit retry the same still-owned callback', async () => {
    const test = fixture()
    test.permission()
    await expect(
      test.answer('allow', async () => {
        throw new Error('fixture persistence failure')
      })
    ).rejects.toThrow('persistence failure')
    expect(test.connection.respond).not.toHaveBeenCalled()
    await test.answer()
    expect(test.connection.respond).toHaveBeenCalledOnce()
  })

  it('holds one claim across an asynchronous commit and refuses stale replies after close', async () => {
    const test = fixture()
    test.permission()
    let release: () => void = () => {}
    const committing = new Promise<void>((resolve) => {
      release = resolve
    })
    const commit = vi.fn(() => committing)
    const first = test.answer('allow', commit)
    expect(commit).toHaveBeenCalledOnce()
    await expect(test.answer()).rejects.toThrow('no longer waiting')
    test.prompts.clear()
    release()
    await expect(first).rejects.toThrow('no longer waiting')
    expect(test.connection.respond).not.toHaveBeenCalled()
  })

  it('preserves grouped question IDs and multiple selections in Cursor extension replies', async () => {
    const test = fixture()
    test.prompts.receive({
      id: 91,
      method: 'cursor/ask_question',
      params: {
        toolCallId: 'ask-1',
        title: 'Choose fixture scope',
        questions: [
          {
            id: 'scope',
            prompt: 'Which scopes?',
            allowMultiple: true,
            options: [
              { id: 'source', label: 'Source' },
              { id: 'tests', label: 'Tests' }
            ]
          },
          { id: 'proof', prompt: 'Include proof?', options: [{ id: 'yes', label: 'Yes' }] }
        ]
      }
    })
    const row = test.rows[0]
    if (!row) {
      throw new Error('No fixture question')
    }
    await test.prompts.answer({
      sessionId: 'orca-session',
      fence: 7,
      itemId: agentJournalItemKey(row.identity),
      kind: 'question',
      response: {
        kind: 'answers',
        answers: [
          { questionId: 'scope', optionIds: ['source', 'tests'] },
          { questionId: 'proof', optionIds: ['yes'] }
        ]
      },
      commit: async () => {}
    })
    expect(test.connection.respond).toHaveBeenCalledWith(91, {
      outcome: {
        outcome: 'answered',
        answers: [
          { questionId: 'scope', selectedOptionIds: ['source', 'tests'] },
          { questionId: 'proof', selectedOptionIds: ['yes'] }
        ]
      }
    })
  })

  it('shows the plan for review and returns the extension rejection outcome', async () => {
    const test = fixture()
    test.prompts.receive({
      id: 'plan-id',
      method: 'cursor/create_plan',
      params: { toolCallId: 'plan-1', name: 'Fixture plan', plan: '# Fixture plan\nRead only.' }
    })
    expect(test.rows[0]?.body).toMatchObject({
      subject: { kind: 'plan', text: '# Fixture plan\nRead only.' }
    })
    await test.answer('reject')
    expect(test.connection.respond).toHaveBeenCalledWith('plan-id', {
      outcome: { outcome: 'rejected' }
    })
  })

  it('refuses malformed, foreign and duplicate option prompts instead of recording ambiguous choices', () => {
    const test = fixture()
    test.prompts.receive({
      id: 'foreign',
      method: 'session/request_permission',
      params: {
        sessionId: 'foreign-provider',
        toolCall: { toolCallId: 'foreign-tool' },
        options: [{ optionId: 'yes', name: 'Yes', kind: 'allow_once' }]
      }
    })
    test.permission(['same', 'same'])
    test.prompts.receive({
      id: 'unknown',
      method: 'fs/read_text_file',
      params: { path: '/not-advertised' }
    })
    expect(test.rows).toHaveLength(0)
    expect(test.connection.respondWithError).toHaveBeenCalledWith(
      'foreign',
      -32602,
      expect.any(String)
    )
    expect(test.connection.respondWithError).toHaveBeenCalledWith(
      'permission-id',
      -32602,
      expect.any(String)
    )
    expect(test.connection.respondWithError).toHaveBeenCalledWith(
      'unknown',
      -32601,
      expect.any(String)
    )
  })
})

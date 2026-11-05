import { describe, expect, it } from 'vitest'
import type { ToolCallUpdate } from '../generated/acp-protocol.generated'
import { OMP_ACP_DIALECT } from './omp-dialect'

const text = (value: string) => ({
  type: 'content' as const,
  content: { type: 'text' as const, text: value }
})
const normalize = (update: ToolCallUpdate) => OMP_ACP_DIALECT.normalizeToolUpdate!(update)

describe('OMP tool updates', () => {
  it('leaves a tool without a command echo as it came', () => {
    const update: ToolCallUpdate = {
      toolCallId: 'call-1',
      status: 'completed',
      rawOutput: { content: [{ type: 'text', text: 'file body' }], details: {} },
      content: [text('file body')]
    }
    const expected = structuredClone(update)
    expect(normalize(update)).toEqual(expected)
  })

  it('keeps a result that itself starts with "$ "', () => {
    const update: ToolCallUpdate = {
      toolCallId: 'call-1',
      status: 'completed',
      rawOutput: { content: [{ type: 'text', text: '$ 5.00' }], details: {} },
      content: [text('$ 5.00')]
    }
    const expected = structuredClone(update)
    expect(normalize(update)).toEqual(expected)
  })

  it.each([0, 3])('keeps an exit %s notice when OMP sent no matching detail', (code) => {
    const output = `done\n\nCommand exited with code ${code}`
    const update = normalize({
      toolCallId: 'call-1',
      status: 'completed',
      rawOutput: {
        content: [{ type: 'text', text: output }],
        details: { wallTimeMs: 12 }
      },
      content: [text('$ ./run'), text(output)]
    })
    expect(update).toMatchObject({
      content: [],
      rawOutput: { stdout: output, exitCode: 0 }
    })
  })

  const command = (
    status: ToolCallUpdate['status'],
    details: Record<string, unknown>,
    rawInput?: unknown
  ): ToolCallUpdate => ({
    toolCallId: 'call-1',
    status,
    ...(rawInput === undefined ? {} : { rawInput }),
    rawOutput: { content: [{ type: 'text', text: 'ok' }], details },
    content: [text('$ ./run'), text('ok')]
  })

  it('shows exit 0 for a foreground command that completed, since OMP omits a zero exit', () => {
    expect(normalize(command('completed', { wallTimeMs: 12 })).rawOutput).toMatchObject({
      stdout: 'ok',
      exitCode: 0
    })
    expect(
      normalize(command('completed', { wallTimeMs: 0, signal: null })).rawOutput
    ).toMatchObject({
      exitCode: 0
    })
  })

  it('infers no exit code for a command that is running, timed out, signalled or in the background', () => {
    for (const update of [
      command('in_progress', { wallTimeMs: 12 }),
      command('completed', { wallTimeMs: 12, timedOut: true }),
      command('completed', { wallTimeMs: 12, signal: 'SIGTERM' }),
      command('completed', { wallTimeMs: 12, async: { jobId: 'job-1' } }),
      command('completed', { wallTimeMs: 12 }, { command: './run', async: true })
    ]) {
      expect(normalize(update).rawOutput).not.toHaveProperty('exitCode')
    }
  })

  it('infers no exit code without foreground timing metadata', () => {
    for (const details of [undefined, {}, { signal: null }]) {
      const update = normalize({
        toolCallId: 'call-1',
        status: 'completed',
        rawOutput: { content: [{ type: 'text', text: 'ok' }], ...(details ? { details } : {}) },
        content: [text('$ ./run'), text('ok')]
      })
      expect(update.rawOutput).toMatchObject({ stdout: 'ok' })
      expect(update.rawOutput).not.toHaveProperty('exitCode')
    }
  })

  it('does not confuse OMP v18.4 service-start completion with a process exit', () => {
    for (const timing of [{}, { wallTimeMs: 12 }]) {
      const update = normalize({
        toolCallId: 'service-call',
        status: 'completed',
        rawOutput: {
          content: [{ type: 'text', text: 'web: running pid=123 ready' }],
          details: {
            ...timing,
            service: { name: 'web', state: 'running', ready: true, timedOut: false, pid: 123 }
          }
        },
        content: [text('$ python3 -m http.server 8765'), text('web: running pid=123 ready')]
      })
      expect(update.rawOutput).toMatchObject({ stdout: 'web: running pid=123 ready' })
      expect(update.rawOutput).not.toHaveProperty('exitCode')
    }
  })

  it('leaves an existing generic command result intact', () => {
    for (const result of [
      { exitCode: 3 },
      { exit_code: 3 },
      { stdout: 'original' },
      { stderr: 'error' },
      { output_for_prompt: 'original' },
      { signal: 'SIGTERM' },
      { timed_out: true }
    ]) {
      const update = command('completed', { wallTimeMs: 12 })
      update.rawOutput = {
        ...result,
        content: [{ type: 'text', text: 'ok' }],
        details: { wallTimeMs: 12 }
      }
      const expected = structuredClone(update)
      expect(normalize(update)).toEqual(expected)
    }
  })

  it("keeps a failed command's reported exit code", () => {
    const update = normalize({
      toolCallId: 'call-1',
      status: 'failed',
      rawOutput: {
        content: [{ type: 'text', text: 'hi\n\nCommand exited with code 3' }],
        details: { exitCode: 3 }
      },
      content: [text('$ ./run'), text('hi\n\nCommand exited with code 3')]
    })
    expect(update.rawOutput).toMatchObject({ stdout: 'hi', exitCode: 3 })
  })
})

describe('OMP ask forms', () => {
  // Verbatim `elicitation/create` from OMP 18.16.0's `ask` with three questions.
  const ask = {
    mode: 'form',
    sessionId: 'session-1',
    message: 'Answer 3 questions',
    requestedSchema: {
      type: 'object',
      properties: {
        q0: {
          type: 'string',
          title: 'Which database?',
          description: 'DB',
          oneOf: [
            { const: 'Postgres', title: 'Postgres', description: 'relational' },
            { const: 'SQLite', title: 'SQLite' },
            { const: 'Mongo', title: 'Mongo' }
          ],
          default: 'SQLite'
        },
        q0__other: { type: 'string', title: 'Other (type your own)' },
        q1: {
          type: 'array',
          title: 'Which features?',
          items: {
            anyOf: [
              { const: 'Auth', title: 'Auth' },
              { const: 'Billing', title: 'Billing' },
              { const: 'Search', title: 'Search' }
            ]
          }
        },
        q1__other: { type: 'string', title: 'Other (type your own)' },
        q2__other: { type: 'string', title: 'Other (type your own)' }
      }
    }
  }

  it('asks every question on one card and answers in the form OMP reads', () => {
    const presentation = OMP_ACP_DIALECT.request!('elicitation/create', ask)!
    expect(presentation.body).toMatchObject({
      kind: 'question',
      questions: [
        {
          id: 'q1',
          question: 'Which database?',
          header: 'DB',
          multiSelect: false,
          options: [
            { id: 'o1', label: 'Postgres', description: 'relational' },
            { id: 'o2', label: 'SQLite (Recommended)' },
            { id: 'o3', label: 'Mongo' }
          ],
          freeTextQuestionId: 'q1'
        },
        { id: 'q2', question: 'Which features?', multiSelect: true, freeTextQuestionId: 'q2' },
        { id: 'q3', question: 'Other (type your own)', options: [], freeTextQuestionId: 'q3' }
      ]
    })
    expect(
      presentation.reply({
        kind: 'answers',
        answers: [
          { questionId: 'q1', optionIds: [], other: 'Cockroach' },
          { questionId: 'q2', optionIds: ['o1', 'o3'], other: 'note' },
          { questionId: 'q3', optionIds: [], other: 'free' }
        ]
      })
    ).toEqual({
      action: 'accept',
      content: {
        q0__other: 'Cockroach',
        q1: ['Auth', 'Search'],
        q1__other: 'note',
        q2__other: 'free'
      }
    })
    expect(presentation.reply(null)).toEqual({ action: 'cancel' })
  })

  it('tells OMP which questions past the fourth were never shown', () => {
    const properties = Object.fromEntries(
      [0, 1, 2, 3, 4].map((n) => [
        `q${n}__other`,
        { type: 'string', title: 'Other (type your own)' }
      ])
    )
    const presentation = OMP_ACP_DIALECT.request!('elicitation/create', {
      ...ask,
      message: 'Answer 5 questions',
      requestedSchema: { type: 'object', properties }
    })!
    const answers = [1, 2, 3, 4].map((n) => ({
      questionId: `q${n}`,
      optionIds: [],
      other: `a${n}`
    }))
    expect(presentation.reply({ kind: 'answers', answers })).toEqual({
      action: 'accept',
      content: {
        q0__other: 'a1',
        q1__other: 'a2',
        q2__other: 'a3',
        q3__other: 'a4',
        q4__other: 'Not shown to the user: Orca shows at most 4 questions at once. Ask again.'
      }
    })
  })

  it('answers a confirm form with a boolean', () => {
    const confirm = OMP_ACP_DIALECT.request!('elicitation/create', {
      mode: 'form',
      sessionId: 'session-1',
      message: 'Switch model?',
      requestedSchema: {
        type: 'object',
        properties: { value: { type: 'boolean' } },
        required: ['value']
      }
    })!
    expect(
      confirm.reply({ kind: 'answers', answers: [{ questionId: 'q1', optionIds: ['o2'] }] })
    ).toEqual({ action: 'accept', content: { value: false } })
  })
})

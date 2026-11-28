import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RuntimeClient } from '../../runtime/client'
import { ORCHESTRATION_QUESTION_HANDLER } from './question-handler'

describe('orchestration ask question input', () => {
  let cwd: string
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin')!

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'orca-question-'))
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    Object.defineProperty(process, 'stdin', stdinDescriptor)
    await rm(cwd, { recursive: true, force: true })
  })

  async function ask(input: [string, string][]) {
    const client = new RuntimeClient(join(cwd, 'unused.sock'), 1_000, null, null)
    let sent: unknown
    vi.spyOn(client, 'call').mockImplementation(async (method, params) => {
      if (method !== 'orchestration.ask') {
        throw new Error(`Unexpected method: ${method}`)
      }
      sent = params
      return {
        id: 'req_1',
        ok: true,
        result: { answer: 'Yes', messageId: 'msg_1', threadId: 'thread_1', timedOut: false },
        _meta: { runtimeId: 'rt_1' }
      }
    })
    await ORCHESTRATION_QUESTION_HANDLER['orchestration ask']({
      flags: new Map<string, string | boolean>([
        ['from', 'term_worker'],
        ['wait', true],
        ['full', true],
        ...input
      ]),
      cwd,
      client,
      json: true
    })
    return sent
  }

  it('preserves Markdown from a file relative to the caller directory', async () => {
    await writeFile(join(cwd, 'question.md'), '# Question\nUse `pnpm check` or $(other)?\n')
    await expect(ask([['question-file', 'question.md']])).resolves.toMatchObject({
      question: '# Question\nUse `pnpm check` or $(other)?\n',
      resume: undefined
    })
  })

  it('preserves piped stdin for --question-file -', async () => {
    Object.defineProperty(process, 'stdin', {
      configurable: true,
      value: Readable.from(['# Question\n', 'Use `pnpm check`?\n'])
    })
    await expect(ask([['question-file', '-']])).resolves.toMatchObject({
      question: '# Question\nUse `pnpm check`?\n'
    })
  })

  it('rejects both question flags before opening the file', async () => {
    await expect(
      ask([
        ['question', 'Inline question'],
        ['question-file', 'missing.md']
      ])
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message: 'Use either --question or --question-file, not both'
    })
  })

  it('reports missing files clearly', async () => {
    await expect(ask([['question-file', 'missing.md']])).rejects.toMatchObject({
      code: 'invalid_argument',
      message: `Could not read ${join(cwd, 'missing.md')}: ENOENT`
    })
  })

  it('requires a question or resume', async () => {
    await expect(ask([])).rejects.toMatchObject({
      code: 'invalid_argument',
      message: 'Choose exactly one of --question, --question-file, or --resume.'
    })
  })

  it('resumes without reading a question', async () => {
    await expect(ask([['resume', 'msg_original']])).resolves.toMatchObject({
      question: undefined,
      resume: 'msg_original'
    })
  })

  it('rejects a file question combined with resume', async () => {
    await writeFile(join(cwd, 'question.md'), 'Another question')
    await expect(
      ask([
        ['question-file', 'question.md'],
        ['resume', 'msg_original']
      ])
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message: 'Choose exactly one of --question, --question-file, or --resume.'
    })
  })
})

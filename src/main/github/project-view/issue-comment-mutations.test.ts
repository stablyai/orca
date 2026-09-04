import { readFile } from 'node:fs/promises'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { runRestMock } = vi.hoisted(() => ({
  runRestMock: vi.fn()
}))

vi.mock('./internals', () => ({
  runRest: runRestMock,
  projectGhExecOptions: (host?: string) => ({ host: host ?? 'github.com' }),
  validateSlugArgs: (owner: string, repo: string) =>
    owner && repo ? { ok: true } : { ok: false, error: { type: 'validation_error' } },
  assertPositiveInt: (value: number, name: string) =>
    Number.isInteger(value) && value > 0
      ? { ok: true, value }
      : { ok: false, error: { type: 'validation_error', message: `${name} invalid` } }
}))

import { addIssueCommentBySlug, updateIssueCommentBySlug } from './issue-comment-mutations'

function expectNoRawBodyField(args: unknown): asserts args is string[] {
  expect(Array.isArray(args)).toBe(true)
  const list = args as string[]
  for (let i = 0; i < list.length; i++) {
    expect(list[i]).not.toMatch(/^body=/)
    if (
      list[i] === '--raw-field' ||
      list[i] === '-f' ||
      list[i] === '--field' ||
      list[i] === '-F'
    ) {
      expect(list[i + 1]).not.toMatch(/^body=/)
    }
  }
}

function mockRunRestJsonCapture(): unknown[] {
  const payloads: unknown[] = []
  runRestMock.mockImplementation(async (args: string[]) => {
    expectNoRawBodyField(args)
    const inputIndex = args.indexOf('--input')
    expect(inputIndex).toBeGreaterThanOrEqual(0)
    payloads.push(JSON.parse(await readFile(args[inputIndex + 1]!, 'utf8')))
    return { ok: true, data: { id: 1 } }
  })
  return payloads
}

describe('slug-addressed comment body writes', () => {
  beforeEach(() => {
    runRestMock.mockReset()
  })

  it('addIssueCommentBySlug sends body through --input JSON', async () => {
    const payloads = mockRunRestJsonCapture()

    await expect(
      addIssueCommentBySlug({
        owner: 'acme',
        repo: 'widgets',
        number: 12,
        body: 'A comment'
      })
    ).resolves.toMatchObject({ ok: true })

    expect(runRestMock).toHaveBeenCalledWith(
      ['-X', 'POST', 'repos/acme/widgets/issues/12/comments', '--input', expect.any(String)],
      undefined,
      'core',
      { host: 'github.com' }
    )
    expect(payloads[0]).toEqual({ body: 'A comment' })
  })

  it('updateIssueCommentBySlug sends body through --input JSON', async () => {
    const payloads = mockRunRestJsonCapture()

    await expect(
      updateIssueCommentBySlug({
        owner: 'acme',
        repo: 'widgets',
        commentId: 44,
        body: 'Edited comment'
      })
    ).resolves.toEqual({ ok: true })

    expect(runRestMock).toHaveBeenCalledWith(
      ['-X', 'PATCH', 'repos/acme/widgets/issues/comments/44', '--input', expect.any(String)],
      undefined,
      'core',
      { host: 'github.com' }
    )
    expect(payloads[0]).toEqual({ body: 'Edited comment' })
  })
})

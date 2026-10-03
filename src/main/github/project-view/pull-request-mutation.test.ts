import { readFile } from 'node:fs/promises'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { runRestMock } = vi.hoisted(() => ({ runRestMock: vi.fn() }))

vi.mock('./internals', () => ({
  assertPositiveInt: (value: number) => ({ ok: true, value }),
  validateSlugArgs: () => ({ ok: true }),
  projectGhExecOptions: (host?: string) => ({ host: host ?? 'github.com' }),
  runRest: runRestMock
}))

import { updatePullRequestBySlug } from './pull-request-mutation'

describe('updatePullRequestBySlug body transport', () => {
  beforeEach(() => {
    runRestMock.mockReset().mockResolvedValue({ ok: true, data: {} })
  })

  it.each([`data:image/png;base64,${'A'.repeat(140_000)}`, ''])(
    'keeps the body off argv and removes the payload file',
    async (body) => {
      let inputPath = ''
      runRestMock.mockImplementation(async (args: string[]) => {
        expect(args.slice(0, 3)).toEqual(['-X', 'PATCH', 'repos/acme/widgets/pulls/12'])
        expect(args).not.toContain(`body=${body}`)
        expect(args).toContain('--input')
        inputPath = args[args.indexOf('--input') + 1]!
        expect(JSON.parse(await readFile(inputPath, 'utf8'))).toEqual({
          title: 'New title',
          body,
          state: 'closed'
        })
        return { ok: true, data: {} }
      })

      await expect(
        updatePullRequestBySlug({
          owner: 'acme',
          repo: 'widgets',
          number: 12,
          host: 'github.corp.example',
          updates: { title: 'New title', body, state: 'closed' }
        })
      ).resolves.toEqual({ ok: true })

      expect(runRestMock).toHaveBeenCalledWith(expect.any(Array), undefined, 'core', {
        host: 'github.corp.example'
      })
      await expect(readFile(inputPath)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  )

  it('keeps title and state updates without a body on raw fields', async () => {
    await updatePullRequestBySlug({
      owner: 'acme',
      repo: 'widgets',
      number: 12,
      updates: { title: 'New title', state: 'closed' }
    })
    expect(runRestMock).toHaveBeenCalledWith(
      [
        '-X',
        'PATCH',
        'repos/acme/widgets/pulls/12',
        '--raw-field',
        'title=New title',
        '--raw-field',
        'state=closed'
      ],
      undefined,
      'core',
      { host: 'github.com' }
    )
  })

  it('returns REST failures and removes the body file', async () => {
    let inputPath = ''
    const error = { type: 'not_found', message: 'Not found' }
    runRestMock.mockImplementation(async (args: string[]) => {
      expect(args).toContain('--input')
      inputPath = args[args.indexOf('--input') + 1]!
      return { ok: false, error }
    })
    await expect(
      updatePullRequestBySlug({
        owner: 'acme',
        repo: 'widgets',
        number: 12,
        updates: { body: 'body' }
      })
    ).resolves.toEqual({ ok: false, error })
    await expect(readFile(inputPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

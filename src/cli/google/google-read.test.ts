import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HandlerContext } from '../dispatch/dispatch'
import type { RuntimeClient } from '../runtime/client'
import { GOOGLE_READ_HANDLERS } from './google-read'

let cwd = ''
let stdout: string[] = []
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'orca-gmail-cli-'))
  stdout = []
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
    stdout.push(String(line))
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(cwd, { recursive: true, force: true })
})

function run(
  command: string,
  flags: [string, string | boolean][],
  answer: (method: string, params: Record<string, unknown>) => unknown
) {
  const call = vi.fn(async (method: string, params: Record<string, unknown>) => ({
    id: 'r',
    ok: true,
    result: await answer(method, params),
    _meta: { runtimeId: 'rt' }
  }))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handlers under test only use `call`.
  const client = { call } as unknown as RuntimeClient
  const context: HandlerContext = { client, cwd, flags: new Map(flags), json: false, rawArgs: [] }
  return { done: GOOGLE_READ_HANDLERS[command]?.(context), call }
}

describe('orca gmail|calendar|contacts', () => {
  it('saves a downloaded attachment here, never over an existing file', async () => {
    const answer = () => ({
      ref: 'gmail:att:m1:1',
      name: 'plan.pdf',
      data: Buffer.from('%PDF').toString('base64')
    })
    await run('gmail read', [['download', 'gmail:att:m1:1']], answer).done
    expect(readFileSync(join(cwd, 'plan.pdf'), 'utf-8')).toBe('%PDF')
    expect(stdout.join('\n')).toContain('Saved plan.pdf to')
    await expect(run('gmail read', [['download', 'gmail:att:m1:1']], answer).done).rejects.toThrow(
      'already exists'
    )
  })

  it('passes the account and the page on', async () => {
    const { done, call } = run(
      'calendar list',
      [
        ['account', 'ada@acme.dev'],
        ['from', '2026-11-09'],
        ['page', 'p2']
      ],
      () => ({
        account: 'ada@acme.dev',
        now: 0,
        timeZone: 'UTC',
        calendar: { id: 'primary', name: 'Ada' },
        from: '2026-11-09T00:00:00Z',
        to: '2026-11-10T00:00:00Z',
        events: []
      })
    )
    await done
    expect(call.mock.calls[0]?.[1]).toMatchObject({
      account: 'ada@acme.dev',
      from: '2026-11-09',
      pageToken: 'p2'
    })
  })
})

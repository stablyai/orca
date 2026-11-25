import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runProcess } from '@orca/process-host'
import { readCursorAuthSession } from './cursor-auth'

vi.mock('@orca/process-host', () => ({ runProcess: vi.fn() }))
vi.mock('../../../foreign-sqlite-readers/foreign-sqlite-reader-spawn', () => ({
  readCursorDesktopProfile: vi.fn(async () => ({ status: 'missing' }))
}))

// Payload {"sub":"auth0|user_1"}; no exp, so it never expires.
const jwt = 'e30.eyJzdWIiOiJhdXRoMHx1c2VyXzEifQ.sig'
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cursor-auth-'))
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  vi.mocked(runProcess).mockReset()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

it('reads the cursor-agent token from auth.dpapi when auth.json points to the Windows secret store', async () => {
  // cursor-agent 2026.11.22 writes {version:1,dpapi} next to auth.json and leaves only the marker there.
  const blob = 'AQAAANCMnd8BFdERjHoAwE/Cl+sBAAAA'
  writeFileSync(join(dir, 'auth.json'), JSON.stringify({ storedIn: 'os-secret-store' }))
  writeFileSync(join(dir, 'auth.dpapi'), JSON.stringify({ version: 1, dpapi: blob }))
  const plaintext = JSON.stringify({ accessToken: jwt, refreshToken: 'r' })
  vi.mocked(runProcess).mockResolvedValue({
    code: 0,
    signal: null,
    stdout: `${Buffer.from(plaintext).toString('base64')}\r\n`,
    stderr: '',
    timedOut: false
  })

  const result = await readCursorAuthSession({
    cliAuthPath: join(dir, 'auth.json'),
    cliConfigPath: join(dir, 'cli-config.json'),
    desktopStateDbPath: join(dir, 'state.vscdb')
  })

  expect(result).toMatchObject({
    status: 'ok',
    session: { source: 'cli', token: { raw: jwt, subject: 'auth0|user_1' } }
  })
  // The encrypted credential travels over stdin, never argv.
  const spec = vi.mocked(runProcess).mock.calls[0]?.[0]
  expect(spec?.input).toBe(blob)
  expect(spec?.args.join(' ')).not.toContain(blob)
})

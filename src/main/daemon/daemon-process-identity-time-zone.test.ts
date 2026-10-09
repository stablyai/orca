import { afterEach, expect, it, vi } from 'vitest'
import { getPsProcessIdentity } from './daemon-process-identity-query'
import { psLocaleEnvironment } from '../../shared/ps-locale-environment'

const { execFileSync } = vi.hoisted(() => ({ execFileSync: vi.fn() }))
vi.mock('node:child_process', () => ({ execFileSync, execFile: vi.fn() }))

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

it.each(['America/Los_Angeles', 'America/New_York', 'UTC'])(
  'keeps the autumn clock transition unambiguous under %s',
  (timezone) => {
    vi.stubEnv('TZ', timezone)
    execFileSync.mockReturnValue('Sun Nov  1 09:30:00 2026 /path/to/orca\n')
    expect(getPsProcessIdentity(42, { utc: true })).toEqual({
      startedAtMs: Date.parse('2026-11-01T09:30:00Z'),
      commandLine: '/path/to/orca'
    })
    expect(execFileSync).toHaveBeenCalledWith(
      'ps',
      ['-p', '42', '-o', 'lstart=', '-o', 'command='],
      expect.objectContaining({ env: expect.objectContaining({ TZ: 'UTC', LC_ALL: 'C' }) })
    )
  }
)

it('treats an unreadable UTC process start as unknown', () => {
  execFileSync.mockReturnValue('                        /path/to/orca\n')
  expect(getPsProcessIdentity(42, { utc: true })?.startedAtMs).toBeNull()
})

it('reads a local-time identity under the pinned ps locale, whatever LANG says', () => {
  vi.stubEnv('LANG', 'de_DE.UTF-8')
  execFileSync.mockReturnValue('Sun Nov  1 09:30:00 2026 /path/to/orca\n')
  expect(getPsProcessIdentity(42)?.commandLine).toBe('/path/to/orca')
  expect(execFileSync).toHaveBeenCalledWith(
    'ps',
    ['-p', '42', '-o', 'lstart=', '-o', 'command='],
    expect.objectContaining({ env: psLocaleEnvironment() })
  )
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveCliCommand } from '../../shared/node-cli-command-resolution'
import { resolveAntigravityUsageCommand } from './antigravity-usage-command'

vi.mock('../../shared/node-cli-command-resolution', () => ({ resolveCliCommand: vi.fn() }))

describe('Antigravity quota executable selection', () => {
  beforeEach(() => vi.mocked(resolveCliCommand).mockReset())

  it.each([
    { platform: 'darwin' as const, command: '"/custom tools/agy"', expected: '/custom tools/agy' },
    { platform: 'linux' as const, command: '/opt/agy', expected: '/opt/agy' },
    {
      platform: 'win32' as const,
      command: '"C:\\Custom Tools\\agy.exe"',
      expected: 'C:\\Custom Tools\\agy.exe'
    }
  ])(
    'uses the configured executable on $platform without falling back to PATH',
    ({ platform, command, expected }) => {
      expect(resolveAntigravityUsageCommand(command, platform)).toEqual({
        ok: true,
        command: expected
      })
      expect(resolveCliCommand).not.toHaveBeenCalled()
    }
  )

  it('resolves a custom executable name rather than agy', () => {
    vi.mocked(resolveCliCommand).mockReturnValue('/opt/custom-agy')
    expect(resolveAntigravityUsageCommand('custom-agy', 'linux')).toEqual({
      ok: true,
      command: '/opt/custom-agy'
    })
    expect(resolveCliCommand).toHaveBeenCalledWith('custom-agy', { platform: 'linux' })
  })

  it.each([
    'agy --print dangerous',
    'agy --',
    'env ACCOUNT=test agy',
    'agy && echo wrong',
    '"unterminated'
  ])('does not append quota arguments to %s or use a different executable', (command) => {
    expect(resolveAntigravityUsageCommand(command, 'linux').ok).toBe(false)
    expect(resolveCliCommand).not.toHaveBeenCalled()
  })
})

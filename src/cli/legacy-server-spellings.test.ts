import { describe, expect, it, vi } from 'vitest'
import {
  canonicalizeLegacyFlagArgv,
  normalizeCommandPositionals,
  parseArgs,
  validateCommandAndFlags
} from './args'
import { unknownCommandData } from './command-suggestion'
import { ignoresRemoteSelection } from './remote-selection-scope'
import { COMMAND_SPECS } from './specs'
import { main } from './index'

function normalize(argv: string[]) {
  return normalizeCommandPositionals(COMMAND_SPECS, parseArgs(argv, undefined, COMMAND_SPECS))
}

describe('old server spellings are input only', () => {
  it('routes the old command and flag to the same handler and flag as the new ones', () => {
    const legacy = normalize(['environment', 'stop', '--environment', 'srv-b', '--yes'])
    const current = normalize(['server', 'stop', '--server', 'srv-b', '--yes'])
    expect(legacy.commandPath).toEqual(['server', 'stop'])
    expect(Object.fromEntries(legacy.flags)).toEqual(Object.fromEntries(current.flags))
    expect(normalize(['host', 'name']).commandPath).toEqual(['server', 'name'])
    expect(normalize(['environment']).commandPath).toEqual(['server'])
  })

  it('accepts both spellings only when their values are equal', () => {
    const same = normalize(['worktree', 'ps', '--environment', 'srv-b', '--server', 'srv-b'])
    expect(() => validateCommandAndFlags(COMMAND_SPECS, same)).not.toThrow()
    expect(same.flags.get('server')).toBe('srv-b')
    for (const argv of [
      ['worktree', 'ps', '--environment', 'srv-a', '--server', 'srv-b'],
      [
        'worktree',
        'set',
        '--worktree',
        'id:x',
        '--parent-worktree',
        'id:y',
        '--parent-environment',
        'local',
        '--parent-server',
        'srv-b'
      ]
    ]) {
      expect(() => validateCommandAndFlags(COMMAND_SPECS, normalize(argv))).toThrow(
        expect.objectContaining({ code: 'invalid_argument' })
      )
    }
  })

  it('suggests and echoes only the new names', () => {
    const { suggestions } = unknownCommandData(COMMAND_SPECS, ['environment', 'stp'])
    expect(suggestions).toContain('server stop')
    expect(suggestions.filter((path) => !path.startsWith('server '))).toEqual([])
    expect(
      canonicalizeLegacyFlagArgv([
        'plugin',
        'list',
        '--environment=box',
        '--parent-environment',
        'x'
      ])
    ).toEqual(['plugin', 'list', '--server=box', '--parent-server', 'x'])
  })

  it('routes `server name` but keeps saved-server management on this computer', () => {
    expect(ignoresRemoteSelection(['server', 'name'])).toBe(false)
    expect(ignoresRemoteSelection(['server', 'list'])).toBe(true)
  })

  it('prints the canonical group for `help environment` as for `environment --help`', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await main(['help', 'environment'])
    await main(['environment', '--help'])
    const [viaHelp, viaFlag] = log.mock.calls.map((call) => String(call[0]))
    log.mockRestore()
    expect(viaHelp).toBe(viaFlag)
    expect(viaHelp.startsWith('orca server\n')).toBe(true)
    expect(viaHelp).not.toContain('environment')
  })

  it('names the canonical group when an old-spelling subcommand is unknown', () => {
    expect(normalize(['environment', 'stp']).commandPath).toEqual(['server', 'stp'])
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { constructorArgsMock, callMock } = vi.hoisted(() => ({
  constructorArgsMock: vi.fn(),
  callMock: vi.fn()
}))

vi.mock('./runtime-client', async () => {
  class RuntimeClient {
    readonly isRemote = false
    call = callMock
    getCliStatus = vi.fn()
    openOrca = vi.fn()

    constructor(...args: unknown[]) {
      constructorArgsMock(...args)
    }
  }

  const { RuntimeClientError, RuntimeRpcFailureError } = await import('./runtime/types.js')
  return { RuntimeClient, RuntimeClientError, RuntimeRpcFailureError }
})

import type { CommandSpec } from './args'
import { commandPathGroupSpecs, isCommandPathGroup } from './command-path-groups'
import { formatGroupHelp } from './help'
import { main } from './index'
import { COMMAND_SPECS } from './specs'

const FIXTURE_SPECS: CommandSpec[] = [
  {
    path: ['linear', 'project', 'show'],
    summary: 'Show one Linear project',
    usage: 'orca linear project show',
    allowedFlags: []
  },
  {
    path: ['linear', 'project', 'update', 'add'],
    summary: 'Post a Linear project update',
    usage: 'orca linear project update add',
    allowedFlags: []
  },
  {
    path: ['linear', 'issue'],
    summary: 'Read Linear issue context',
    usage: 'orca linear issue',
    allowedFlags: []
  },
  {
    path: ['worktree', 'rm'],
    aliases: [['worktree', 'remove']],
    summary: 'Remove a worktree',
    usage: 'orca worktree rm',
    allowedFlags: []
  }
]

const PREVIOUS_HARD_CODED_GROUPS: string[][] = [
  ['account'],
  ['artifacts'],
  ['automations'],
  ['project'],
  ['repo'],
  ['worktree'],
  ['terminal'],
  ['file'],
  ['tab'],
  ['cookie'],
  ['intercept'],
  ['capture'],
  ['mouse'],
  ['set'],
  ['clipboard'],
  ['dialog'],
  ['storage'],
  ['orchestration'],
  ['computer'],
  ['emulator'],
  ['agent'],
  ['environment'],
  ['diagnostics'],
  ['linear'],
  ['skills'],
  ['vm'],
  ['agent', 'hooks'],
  ['storage', 'local'],
  ['storage', 'session']
]

describe('isCommandPathGroup', () => {
  it('recognizes every exact prefix of a registered command path', () => {
    expect(isCommandPathGroup(FIXTURE_SPECS, ['linear'])).toBe(true)
    expect(isCommandPathGroup(FIXTURE_SPECS, ['linear', 'project'])).toBe(true)
    expect(isCommandPathGroup(FIXTURE_SPECS, ['linear', 'project', 'update'])).toBe(true)
  })

  it('does not treat a complete leaf command as a group', () => {
    expect(isCommandPathGroup(FIXTURE_SPECS, ['linear', 'project', 'show'])).toBe(false)
    expect(isCommandPathGroup(FIXTURE_SPECS, ['linear', 'issue'])).toBe(false)
  })

  it('rejects an unregistered path and the empty path', () => {
    expect(isCommandPathGroup(FIXTURE_SPECS, ['linear', 'projekt'])).toBe(false)
    expect(isCommandPathGroup(FIXTURE_SPECS, [])).toBe(false)
  })

  it('recognizes a prefix contributed only by an alias path', () => {
    expect(isCommandPathGroup(FIXTURE_SPECS, ['worktree'])).toBe(true)
  })

  // Why: the hard-coded list this replaced must not lose a single group.
  it.each(
    PREVIOUS_HARD_CODED_GROUPS.map((group) => [group.join(' '), group] as [string, string[]])
  )('still recognizes the previously hard-coded group %s', (_label, group) => {
    expect(isCommandPathGroup(COMMAND_SPECS, group)).toBe(true)
  })

  it('recognizes the nested Linear project group in the live registry', () => {
    expect(isCommandPathGroup(COMMAND_SPECS, ['linear', 'project'])).toBe(true)
  })
})

describe('commandPathGroupSpecs', () => {
  it('returns only the specs nested under the group', () => {
    const paths = commandPathGroupSpecs(FIXTURE_SPECS, ['linear', 'project']).map(
      (spec) => spec.path
    )

    expect(paths).toEqual([
      ['linear', 'project', 'show'],
      ['linear', 'project', 'update', 'add']
    ])
  })

  it('returns only the leaf for a deeper group', () => {
    const paths = commandPathGroupSpecs(FIXTURE_SPECS, ['linear', 'project', 'update']).map(
      (spec) => spec.path
    )

    expect(paths).toEqual([['linear', 'project', 'update', 'add']])
  })
})

describe('formatGroupHelp', () => {
  it('strips the group prefix from nested command labels', () => {
    const help = formatGroupHelp(FIXTURE_SPECS, ['linear', 'project'])

    expect(help).toContain('orca linear project')
    expect(help).toContain('Usage: orca linear project <command> [options]')
    expect(help).toContain('show')
    expect(help).toContain('update add')
    expect(help).not.toContain('issue')
    expect(help).toContain('Run `orca linear project <command> --help` for command-specific usage.')
  })

  it('lists a deeper group down to its immediate leaf', () => {
    const help = formatGroupHelp(FIXTURE_SPECS, ['linear', 'project', 'update'])

    expect(help).toContain('orca linear project update')
    expect(help).toContain('add')
    expect(help).not.toContain('show')
  })
})

describe('group help through main', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    constructorArgsMock.mockClear()
    callMock.mockReset()
    process.exitCode = undefined
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('prints nested project group help for --help without any RPC', async () => {
    await main(['linear', 'project', '--help'], '/tmp/repo')

    const output = String(vi.mocked(console.log).mock.calls[0][0])
    expect(output).toContain('orca linear project')
    expect(output).toContain('show')
    expect(output).toContain('statuses')
    expect(output).toContain('labels')
    expect(output).toContain('list')
    expect(output).not.toContain('linear issue')
    expect(callMock).not.toHaveBeenCalled()
    expect(constructorArgsMock).not.toHaveBeenCalled()
    expect(process.exitCode).toBeUndefined()
  })

  it('prints the same group help for a bare group path and constructs no client', async () => {
    await main(['linear', 'project'], '/tmp/repo')

    const output = String(vi.mocked(console.log).mock.calls[0][0])
    expect(output).toContain('Usage: orca linear project <command> [options]')
    expect(output).toContain('statuses')
    expect(callMock).not.toHaveBeenCalled()
    expect(constructorArgsMock).not.toHaveBeenCalled()
    expect(process.exitCode).toBeUndefined()
  })

  it('keeps the top-level linear group help listing its nested commands', async () => {
    await main(['linear', '--help'], '/tmp/repo')

    const output = String(vi.mocked(console.log).mock.calls[0][0])
    expect(output).toContain('orca linear')
    expect(output).toContain('issue')
    expect(output).toContain('project show')
    expect(callMock).not.toHaveBeenCalled()
  })

  it('still fails a genuinely unknown command with exit code 1', async () => {
    await main(['linear', 'projekt'], '/tmp/repo')

    expect(process.exitCode).toBe(1)
    expect(callMock).not.toHaveBeenCalled()
    expect(String(vi.mocked(console.error).mock.calls[0][0])).toContain(
      'Unknown command: linear projekt'
    )
  })

  it('still exits 1 for --help on an unknown command', async () => {
    await main(['linear', 'projekt', '--help'], '/tmp/repo')

    expect(process.exitCode).toBe(1)
    expect(constructorArgsMock).not.toHaveBeenCalled()
  })
})

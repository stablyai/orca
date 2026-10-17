import { describe, expect, it, vi } from 'vitest'
import { getManagedAgentHookTarget } from '../../shared/managed-agent-hook-targets'
import { agentsFailingHookInstallIdentityProbe } from './managed-hook-identity-gate'

const bobTarget = getManagedAgentHookTarget('bob')!
const claudeTarget = getManagedAgentHookTarget('claude')!

// Real `bob --help` output from the two products that install under that name.
const NEOVIM_BOB_HELP = 'bob 4.0.0\nA version manager for neovim\n\nUSAGE:\n    bob <SUBCOMMAND>'
const BOB_SHELL_HELP = 'Usage: bob [options] [command]\n\nBob in your terminal\n'
const resolveAsIs = async (command: string): Promise<string | null> => command

describe('managed hook identity gate', () => {
  it('excludes Bob when the bob on PATH is the Neovim version manager', async () => {
    const excluded = await agentsFailingHookInstallIdentityProbe(
      [bobTarget],
      async () => ({
        stdout: NEOVIM_BOB_HELP,
        stderr: ''
      }),
      null,
      resolveAsIs
    )
    expect([...excluded]).toEqual(['bob'])
  })

  it('keeps Bob when the probe shows real Bob Shell', async () => {
    const excluded = await agentsFailingHookInstallIdentityProbe(
      [bobTarget],
      async () => ({
        stdout: BOB_SHELL_HELP,
        stderr: ''
      }),
      null,
      resolveAsIs
    )
    expect([...excluded]).toEqual([])
  })

  // Why: hiding a real install is worse than the collision, and an unrunnable probe proves nothing.
  it('fails open when the probe cannot run', async () => {
    const excluded = await agentsFailingHookInstallIdentityProbe(
      [bobTarget],
      async () => {
        throw new Error('ENOENT')
      },
      null,
      resolveAsIs
    )
    expect([...excluded]).toEqual([])
  })

  it('spawns nothing for agents that declare no identity exclusion', async () => {
    const probe = vi.fn()
    const excluded = await agentsFailingHookInstallIdentityProbe(
      [claudeTarget],
      probe,
      null,
      resolveAsIs
    )
    expect(probe).not.toHaveBeenCalled()
    expect([...excluded]).toEqual([])
  })

  it('keeps Bob when the Settings command override is the real Bob Shell', async () => {
    const probe = vi.fn(async (command: string) => ({
      stdout: command === '/opt/bobshell/bob' ? BOB_SHELL_HELP : NEOVIM_BOB_HELP,
      stderr: ''
    }))
    const excluded = await agentsFailingHookInstallIdentityProbe(
      [bobTarget],
      probe,
      { agentCmdOverrides: { bob: '/opt/bobshell/bob chat --trust' } },
      resolveAsIs
    )
    expect(probe).toHaveBeenCalledWith('/opt/bobshell/bob', ['--help'])
    expect([...excluded]).toEqual([])
  })

  // Why: a probe that reaches neither pattern (empty output) must not be read as proof of identity.
  it('excludes Bob when the probe output proves nothing', async () => {
    const excluded = await agentsFailingHookInstallIdentityProbe(
      [bobTarget],
      async () => ({
        stdout: '',
        stderr: ''
      }),
      null,
      resolveAsIs
    )
    expect([...excluded]).toEqual(['bob'])
  })

  it('excludes Bob when a stale override is off PATH and bare bob is Neovim', async () => {
    // Why throw: the real probe throws for a command it cannot resolve, which fails open.
    const probe = vi.fn(async (command: string) => {
      if (command !== '/usr/local/bin/bob') {
        throw new Error(`${command} is not on PATH`)
      }
      return { stdout: NEOVIM_BOB_HELP, stderr: '' }
    })
    const excluded = await agentsFailingHookInstallIdentityProbe(
      [bobTarget],
      probe,
      { agentCmdOverrides: { bob: 'bobshell chat --trust' } },
      async (command) => (command === 'bob' ? '/usr/local/bin/bob' : null)
    )
    expect(probe).toHaveBeenCalledTimes(1)
    expect(probe).toHaveBeenCalledWith('/usr/local/bin/bob', ['--help'])
    expect([...excluded]).toEqual(['bob'])
  })
})

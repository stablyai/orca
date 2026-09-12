import { describe, expect, it, vi } from 'vitest'
import { getManagedAgentHookTarget } from '../../shared/managed-agent-hook-targets'
import { agentsFailingHookInstallIdentityProbe } from './managed-hook-identity-gate'

const bobTarget = getManagedAgentHookTarget('bob')!
const claudeTarget = getManagedAgentHookTarget('claude')!

// Real `bob --help` output from the two products that install under that name.
const NEOVIM_BOB_HELP = 'bob 4.0.0\nA version manager for neovim\n\nUSAGE:\n    bob <SUBCOMMAND>'
const BOB_SHELL_HELP = 'Usage: bob [options] [command]\n\nBob in your terminal\n'

describe('managed hook identity gate', () => {
  it('excludes Bob when the bob on PATH is the Neovim version manager', async () => {
    const excluded = await agentsFailingHookInstallIdentityProbe([bobTarget], async () => ({
      stdout: NEOVIM_BOB_HELP,
      stderr: ''
    }))
    expect([...excluded]).toEqual(['bob'])
  })

  it('keeps Bob when the probe shows real Bob Shell', async () => {
    const excluded = await agentsFailingHookInstallIdentityProbe([bobTarget], async () => ({
      stdout: BOB_SHELL_HELP,
      stderr: ''
    }))
    expect([...excluded]).toEqual([])
  })

  // Why: hiding a real install is worse than the collision, and an unrunnable probe proves nothing.
  it('fails open when the probe cannot run', async () => {
    const excluded = await agentsFailingHookInstallIdentityProbe([bobTarget], async () => {
      throw new Error('ENOENT')
    })
    expect([...excluded]).toEqual([])
  })

  it('spawns nothing for agents that declare no identity exclusion', async () => {
    const probe = vi.fn()
    const excluded = await agentsFailingHookInstallIdentityProbe([claudeTarget], probe)
    expect(probe).not.toHaveBeenCalled()
    expect([...excluded]).toEqual([])
  })

  // Why: a probe that reaches neither pattern (empty output) must not be read as proof of identity.
  it('excludes Bob when the probe output proves nothing', async () => {
    const excluded = await agentsFailingHookInstallIdentityProbe([bobTarget], async () => ({
      stdout: '',
      stderr: ''
    }))
    expect([...excluded]).toEqual(['bob'])
  })
})

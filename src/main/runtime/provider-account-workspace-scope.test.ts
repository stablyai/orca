import { describe, expect, it } from 'vitest'
import { assertProviderAccountRefForWorkspace } from './provider-account-workspace-scope'

const hostWorkspace = { path: '/Users/ada/wt', connectionId: null }
const wslWorkspace = { path: '\\\\wsl.localhost\\Ubuntu\\home\\ada\\wt', connectionId: null }

describe('assertProviderAccountRefForWorkspace', () => {
  it('accepts a matching host Codex account', () => {
    expect(() =>
      assertProviderAccountRefForWorkspace({
        agent: 'codex',
        providerAccountRef: { provider: 'codex', accountId: 'account-a', runtime: 'host' },
        workspace: hostWorkspace
      })
    ).not.toThrow()
  })

  it('rejects a non-Codex agent or provider', () => {
    expect(() =>
      assertProviderAccountRefForWorkspace({
        agent: 'claude',
        providerAccountRef: { provider: 'codex', accountId: 'account-a', runtime: 'host' },
        workspace: hostWorkspace
      })
    ).toThrow('agent_session_account_agent_mismatch')
  })

  it('rejects an SSH-connected workspace', () => {
    expect(() =>
      assertProviderAccountRefForWorkspace({
        agent: 'codex',
        providerAccountRef: { provider: 'codex', accountId: 'account-a', runtime: 'host' },
        workspace: { path: '/home/ada/wt', connectionId: 'ssh-1' }
      })
    ).toThrow('agent_session_account_runtime_mismatch')
  })

  it('rejects a WSL distro that does not match the workspace', () => {
    expect(() =>
      assertProviderAccountRefForWorkspace({
        agent: 'codex',
        providerAccountRef: {
          provider: 'codex',
          accountId: 'account-a',
          runtime: 'wsl',
          wslDistro: 'Debian'
        },
        workspace: wslWorkspace
      })
    ).toThrow('agent_session_account_runtime_mismatch')
  })
})

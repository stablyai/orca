import { describe, expect, it } from 'vitest'
import { wslAuthProxyStatus } from './wsl-auth-proxy-status'

const wslAccount = {
  id: 'wsl-1',
  managedAuthRuntime: 'wsl' as const,
  wslDistro: 'Ubuntu',
  wslLinuxAuthPath: '/home/u/.local/share/orca/claude-profiles/wsl-1/home'
}

describe('wslAuthProxyStatus', () => {
  it('stays absent without WSL accounts and reports the guest file', () => {
    expect(wslAuthProxyStatus([])).toBeUndefined()
    expect(wslAuthProxyStatus([wslAccount], () => false)).toBe('unsupported:wsl')
    expect(wslAuthProxyStatus([wslAccount], () => true)).toBe('on')
  })
})

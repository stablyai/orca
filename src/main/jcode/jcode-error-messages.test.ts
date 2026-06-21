import { describe, expect, it } from 'vitest'
import { friendlyChildError } from './jcode-error-messages'

describe('friendlyChildError', () => {
  it('maps jcode ENOENT to a "找不到 jcode" message keeping the raw detail', () => {
    const msg = friendlyChildError('spawn /Users/vinny/.cargo/bin/jcode ENOENT', null)
    expect(msg).toContain('找不到 jcode 程序')
    expect(msg).toContain('ENOENT')
  })

  it('maps an SSH connection failure to a remote-host message naming the host', () => {
    const msg = friendlyChildError(
      'ssh: connect to host comfyui-host port 22: Connection refused',
      'comfyui-host'
    )
    expect(msg).toContain('无法连接远程主机 comfyui-host')
    expect(msg).toContain('Connection refused')
  })

  it('does NOT apply the remote-host mapping when there is no remote host', () => {
    const msg = friendlyChildError('Connection refused', null)
    expect(msg).toBe('Connection refused')
  })

  it('passes a generic non-zero-exit message through unchanged', () => {
    expect(friendlyChildError('jcode exited with code 1', null)).toBe('jcode exited with code 1')
  })

  it('falls back to a generic message for empty input', () => {
    expect(friendlyChildError('   ', null)).toBe('jcode 运行出错')
  })
})

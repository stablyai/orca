import { describe, it, expect, beforeEach } from 'vitest'
import { PortRegistry } from './port-registry'

describe('PortRegistry', () => {
  let reg: PortRegistry
  beforeEach(() => { reg = new PortRegistry() })

  it('allocates a distinct entry per worktree with a token', () => {
    const a = reg.allocate('wt-a', 4001)
    const b = reg.allocate('wt-b', 4002)
    expect(a.port).toBe(4001)
    expect(a.authToken).toMatch(/^[0-9a-f-]{36}$|.{16,}/)
    expect(b.port).not.toBe(a.port)
  })

  it('routes a port back to its worktree', () => {
    reg.allocate('wt-a', 4001)
    expect(reg.worktreeForPort(4001)).toBe('wt-a')
    expect(reg.worktreeForPort(9999)).toBeUndefined()
  })

  it('release removes the entry', () => {
    reg.allocate('wt-a', 4001)
    reg.release('wt-a')
    expect(reg.worktreeForPort(4001)).toBeUndefined()
  })

  it('setPort updates port without changing authToken', () => {
    const { authToken } = reg.allocate('wt-a', 0)
    reg.setPort('wt-a', 4042)
    expect(reg.worktreeForPort(4042)).toBe('wt-a')
    expect(reg.worktreeForPort(0)).toBeUndefined()
    expect(reg.entry('wt-a')?.authToken).toBe(authToken)
  })
})

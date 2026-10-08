import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { bindProviderPtyInput } from './input-binding'
import { ptyIncarnationById, ptyOwnership } from './ownership-state'

const { provider, registry } = vi.hoisted(() => ({
  provider: { hasPty: vi.fn(() => true) },
  registry: { current: { hasPty: (): boolean => true } }
}))
vi.mock('./registry', () => ({ tryGetProviderForPty: () => registry.current }))
const PTY = 'input-binding-test'
beforeEach(() => {
  registry.current = provider
})

afterEach(() => {
  ptyOwnership.delete(PTY)
  ptyIncarnationById.delete(PTY)
  provider.hasPty.mockReturnValue(true)
  registry.current = provider
})

describe('provider input binding', () => {
  it('allows a known restored PTY before renderer ownership is populated', () => {
    const binding = bindProviderPtyInput(PTY)
    expect(binding.isCurrent()).toBe(true)
    provider.hasPty.mockReturnValue(false)
    expect(binding.isCurrent()).toBe(false)
  })

  it('fences retired ownership and replacement incarnations on the same key', () => {
    ptyOwnership.set(PTY, null)
    ptyIncarnationById.set(PTY, 'old')
    const old = bindProviderPtyInput(PTY)
    expect(old.isCurrent()).toBe(true)
    ptyOwnership.delete(PTY)
    expect(old.isCurrent()).toBe(false)
    ptyOwnership.set(PTY, null)
    ptyIncarnationById.set(PTY, 'new')
    const current = bindProviderPtyInput(PTY)
    expect(current.key).toBe(old.key)
    expect(current.isCurrent()).toBe(true)
    expect(old.isCurrent()).toBe(false)
  })
  it('keeps a binding across provider replacement and learns an unknown incarnation', () => {
    const binding = bindProviderPtyInput(PTY)
    ptyIncarnationById.set(PTY, 'same')
    registry.current = { hasPty: () => true }
    expect(binding.isCurrent()).toBe(true)
    registry.current = { hasPty: () => true }
    expect(binding.isCurrent()).toBe(true)
    ptyIncarnationById.set(PTY, 'replacement')
    expect(binding.isCurrent()).toBe(false)
  })
})

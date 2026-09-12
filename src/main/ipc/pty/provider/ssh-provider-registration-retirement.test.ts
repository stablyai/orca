import { afterEach, expect, it, vi } from 'vitest'
import type { IPtyProvider } from '../../../providers/types'
import {
  registerSshPtyProvider,
  unregisterSshPtyProviderIfCurrent,
  sshProviders,
  sshProvidersByGeneration
} from './registry'

const targets = ['retirement-source', 'retirement-sibling']
const generations = [901001, 901002]
afterEach(() => {
  for (const id of targets) {
    sshProviders.delete(id)
  }
  for (const generation of generations) {
    sshProvidersByGeneration.delete(generation)
  }
})
function provider(providerGeneration = generations[0]) {
  return { providerGeneration, dispose: vi.fn(), shutdown: vi.fn() } as unknown as IPtyProvider & {
    providerGeneration: number
    dispose: ReturnType<typeof vi.fn>
  }
}

it('removes only exact registry indexes without provider disposal or sibling mutation', () => {
  const original = provider()
  const sibling = provider(generations[1])
  registerSshPtyProvider(targets[0], original)
  registerSshPtyProvider(targets[1], sibling)
  expect(unregisterSshPtyProviderIfCurrent(targets[0], original, generations[0])).toBe(true)
  expect(sshProviders.has(targets[0])).toBe(false)
  expect(sshProvidersByGeneration.has(generations[0])).toBe(false)
  expect(sshProviders.get(targets[1])).toBe(sibling)
  expect(sshProvidersByGeneration.get(generations[1])).toBe(sibling)
  expect(original.dispose).not.toHaveBeenCalled()
  expect(original.shutdown).not.toHaveBeenCalled()
  expect(unregisterSshPtyProviderIfCurrent(targets[0], original, generations[0])).toBe(false)
})

it.each(['replacement', 'generation', 'index', 'missing', 'invalid'] as const)(
  'refuses stale %s without changing either index',
  (kind) => {
    const original = provider()
    registerSshPtyProvider(targets[0], original)
    if (kind === 'replacement') {
      sshProviders.set(targets[0], provider(generations[1]))
    }
    if (kind === 'generation') {
      original.providerGeneration = generations[1]
    }
    if (kind === 'index') {
      sshProvidersByGeneration.set(generations[0], provider())
    }
    if (kind === 'missing') {
      sshProvidersByGeneration.delete(generations[0])
    }
    const target = sshProviders.get(targets[0])
    const indexed = sshProvidersByGeneration.get(generations[0])
    expect(
      unregisterSshPtyProviderIfCurrent(
        targets[0],
        original,
        kind === 'invalid' ? Number.NaN : generations[0]
      )
    ).toBe(false)
    expect(sshProviders.get(targets[0])).toBe(target)
    expect(sshProvidersByGeneration.get(generations[0])).toBe(indexed)
    expect(original.dispose).not.toHaveBeenCalled()
  }
)

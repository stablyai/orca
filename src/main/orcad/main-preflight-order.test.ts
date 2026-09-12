import { describe, expect, it, vi } from 'vitest'
import process from 'node:process'

/**
 * The precondition is only worth anything if it runs first. A loader failure is not
 * catchable, so a preflight that lands after `main()` has already reached
 * `await import('../ipc/pty')` prevents nothing.
 */
const order: string[] = []

vi.mock('./orcad-native-preflight', () => ({
  runOrcadNativePreflight: () => {
    order.push('preflight')
    return true
  }
}))

vi.mock('./orcad-entry', () => ({
  main: async () => {
    order.push('main')
  }
}))
vi.mock('./orcad-managed-stop-command', () => ({
  runOrcadManagedStopCommand: async () => {
    order.push('completion')
  }
}))

describe('orcad entry', () => {
  it('runs the native preflight before starting the runtime', async () => {
    await import('./main')
    await vi.waitFor(() => expect(order).toContain('main'))

    expect(order).toEqual(['preflight', 'main'])
  })

  it('does not run native preflight or runtime startup for bound completion', async () => {
    const argv = process.argv
    process.argv = ['bun', 'orcad.js', '--complete-managed-stop', '{}', '/home']
    order.length = 0
    vi.resetModules()
    try {
      await import('./main')
      await vi.waitFor(() => expect(order).toContain('completion'))
      expect(order).toEqual(['completion'])
    } finally {
      process.argv = argv
    }
  })
})

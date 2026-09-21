import { describe, expect, it, vi } from 'vitest'

const { hydrateMock, registerHandlersMock } = vi.hoisted(() => ({
  hydrateMock: vi.fn(),
  registerHandlersMock: vi.fn()
}))

vi.mock('./register-handlers', () => ({
  registerPtyHandlers: registerHandlersMock
}))

vi.mock('../../memory/hydrate-local-pty-registry', () => ({
  hydrateLocalPtyRegistryAtBoot: hydrateMock
}))

import { registerHeadlessPtyRuntime } from './register-headless-runtime'

describe('registerHeadlessPtyRuntime', () => {
  it('registers handlers before awaiting registry hydration', async () => {
    let resolveHydration!: () => void
    const hydration = new Promise<void>((resolve) => {
      resolveHydration = resolve
    })
    const events: string[] = []
    registerHandlersMock.mockImplementation(() => events.push('handlers'))
    hydrateMock.mockImplementation(() => {
      events.push('hydrate')
      return hydration
    })
    const store = {} as never

    const ready = registerHeadlessPtyRuntime({} as never, undefined, undefined, undefined, store)

    expect(events).toEqual(['handlers', 'hydrate'])
    expect(registerHandlersMock).toHaveBeenCalledOnce()
    expect(hydrateMock).toHaveBeenCalledWith(store)

    resolveHydration()
    await ready
  })
})

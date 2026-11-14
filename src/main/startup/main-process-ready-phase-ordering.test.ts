import { beforeEach, describe, expect, it, vi } from 'vitest'

const phaseEvents: string[] = []
let releaseI18n: (() => void) | null = null

vi.mock('./main-process-ready-foundation', () => ({
  initializeReadyFoundation: vi.fn(async () => {
    phaseEvents.push('foundation')
  })
}))
vi.mock('./main-process-ready-runtime', () => ({
  initializeReadyRuntimeServices: vi.fn(async () => {
    phaseEvents.push('runtime-services')
  })
}))
vi.mock('./main-window/main-process-i18n-menu', () => ({
  initializeMainProcessI18nAndMenu: vi.fn(
    () =>
      new Promise<void>((resolve) => {
        phaseEvents.push('i18n-start')
        releaseI18n = () => {
          phaseEvents.push('i18n-done')
          resolve()
        }
      })
  )
}))
vi.mock('./runtime-startup/main-process-runtime-launch', () => ({
  initializeMainProcessRuntimeLaunch: vi.fn(async () => {
    phaseEvents.push('launch-start')
    await Promise.resolve()
    phaseEvents.push('window-created')
  })
}))

const { initializeMainProcessReady } = await import('./main-process-ready')
await import('./main-process-state')

describe('ready-phase concurrency', () => {
  beforeEach(() => {
    phaseEvents.length = 0
    releaseI18n = null
  })

  it('still resolves only once i18n and the menu have settled', async () => {
    const options = {
      openMainWindow: vi.fn(),
      handleMacAppActivation: vi.fn()
    } as unknown as Parameters<typeof initializeMainProcessReady>[0]

    const ready = initializeMainProcessReady(options)
    let settled = false
    void ready.then(() => {
      settled = true
    })
    for (let tick = 0; tick < 8; tick += 1) {
      await Promise.resolve()
    }

    expect(settled).toBe(false)
    releaseI18n?.()
    await ready
    expect(settled).toBe(true)
  })
})

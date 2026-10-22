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
vi.mock('./main-process-i18n-menu', () => ({
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
vi.mock('./main-process-runtime-launch', () => ({
  initializeMainProcessRuntimeLaunch: vi.fn(async () => {
    phaseEvents.push('launch-start')
    await Promise.resolve()
    phaseEvents.push('window-created')
  })
}))

const { initializeMainProcessReady } = await import('./main-process-ready')

describe('ready-phase concurrency', () => {
  beforeEach(() => {
    phaseEvents.length = 0
    releaseI18n = null
  })

  it('creates the window without waiting for i18n and the native menu', async () => {
    const options = {
      openMainWindow: vi.fn(),
      handleMacAppActivation: vi.fn()
    } as unknown as Parameters<typeof initializeMainProcessReady>[0]

    const ready = initializeMainProcessReady(options)
    // Drain the launch phase's microtasks while i18n is still pending.
    for (let tick = 0; tick < 8; tick += 1) {
      await Promise.resolve()
    }

    expect(phaseEvents).toEqual([
      'foundation',
      'runtime-services',
      'i18n-start',
      'launch-start',
      'window-created'
    ])

    releaseI18n?.()
    await ready
    expect(phaseEvents.at(-1)).toBe('i18n-done')
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

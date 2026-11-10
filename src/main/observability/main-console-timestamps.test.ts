import { describe, expect, it, vi } from 'vitest'
import { installMainConsoleTimestamps } from './main-console-timestamps'

describe('installMainConsoleTimestamps', () => {
  it('prefixes an ISO timestamp once and keeps format arguments intact', () => {
    const log = vi.fn()
    const target = { log, info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
    const now = (): Date => new Date('2026-01-02T03:04:05.678Z')

    installMainConsoleTimestamps(target, now)
    installMainConsoleTimestamps(target, now)
    target.log('hello %s', 'world')
    target.log({ a: 1 })

    expect(log.mock.calls).toEqual([
      ['2026-01-02T03:04:05.678Z hello %s', 'world'],
      ['2026-01-02T03:04:05.678Z', { a: 1 }]
    ])
  })
})

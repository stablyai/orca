import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CustomCssSnapshot } from '../../shared/custom-css'
import { CustomCssService } from './custom-css-service'

const { startShallowWatcher } = vi.hoisted(() => ({ startShallowWatcher: vi.fn() }))
vi.mock('../ipc/parcel-watcher-shallow-subscription', () => ({ startShallowWatcher }))

describe('CustomCssService watcher recovery', () => {
  let home: string
  let service: CustomCssService
  let onChanged: ReturnType<typeof vi.fn<(snapshot: CustomCssSnapshot) => void>>
  let failCurrentWatcher: (() => void) | null

  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    failCurrentWatcher = null
    startShallowWatcher.mockImplementation(
      (_directory: string, _paths: string[], _onEvents: unknown, onError: (e: Error) => void) => {
        failCurrentWatcher = () => onError(new Error('watcher died'))
        return { unsubscribe: () => Promise.resolve() }
      }
    )
    home = mkdtempSync(join(tmpdir(), 'orca-custom-css-retry-'))
    onChanged = vi.fn<(snapshot: CustomCssSnapshot) => void>()
    service = new CustomCssService({ homePath: home, onChanged })
  })

  afterEach(() => {
    service.dispose()
    vi.useRealTimers()
    vi.restoreAllMocks()
    startShallowWatcher.mockReset()
    rmSync(home, { recursive: true, force: true })
  })

  it('re-arms the watcher after an error and publishes what was saved meanwhile', async () => {
    service.getSnapshot()
    failCurrentWatcher?.()
    writeFileSync(service.getPath(), ':root { --background: #1e1e2e; }')

    await vi.advanceTimersByTimeAsync(500)

    expect(startShallowWatcher).toHaveBeenCalledTimes(2)
    expect(onChanged).toHaveBeenLastCalledWith(
      expect.objectContaining({ exists: true, css: ':root { --background: #1e1e2e; }' })
    )
  })

  it('gives up after the bounded number of retries', async () => {
    service.getSnapshot()
    for (let attempt = 0; attempt < 6; attempt++) {
      failCurrentWatcher?.()
      await vi.advanceTimersByTimeAsync(60_000)
    }

    expect(startShallowWatcher).toHaveBeenCalledTimes(6)
  })

  it('stops retrying once disposed', async () => {
    service.getSnapshot()
    failCurrentWatcher?.()
    service.dispose()

    await vi.advanceTimersByTimeAsync(60_000)

    expect(startShallowWatcher).toHaveBeenCalledTimes(1)
    expect(onChanged).not.toHaveBeenCalled()
  })
})

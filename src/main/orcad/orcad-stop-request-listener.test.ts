import { describe, expect, it, vi } from 'vitest'
import { ORCAD_STOP_REQUEST_FILENAME } from '../../shared/orcad-stop-request'
import { installOrcadStopRequestListener } from './orcad-stop-request-listener'

describe('orcad stop requests', () => {
  it('installs the slot-local listener on POSIX hosts too', () => {
    const watcher = { on: vi.fn(), unref: vi.fn(), close: vi.fn() }
    const watchDirectory = vi.fn(() => watcher)
    const listener = installOrcadStopRequestListener(vi.fn(), {
      installRoot: '/opt/orcad',
      watchDirectory: watchDirectory as never,
      unlinkFile: vi.fn(() => {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      })
    })

    expect(watchDirectory).toHaveBeenCalledWith('/opt/orcad', expect.any(Function))
    listener.close()
    expect(watcher.close).toHaveBeenCalledOnce()
  })

  it('consumes an already-present request after installing the watcher', () => {
    const onRequest = vi.fn()
    const unlinkFile = vi.fn()
    const watcher = { on: vi.fn(), unref: vi.fn(), close: vi.fn() }
    const watchDirectory = vi.fn(() => watcher)

    const listener = installOrcadStopRequestListener(onRequest, {
      installRoot: 'C:\\orca',
      watchDirectory: watchDirectory as never,
      unlinkFile
    })
    expect(unlinkFile).toHaveBeenCalledWith(expect.stringContaining(ORCAD_STOP_REQUEST_FILENAME))
    expect(onRequest).toHaveBeenCalledOnce()
    expect(watcher.unref).toHaveBeenCalledOnce()
    listener.close()
  })

  it('ignores unrelated events and consumes one matching or unnamed request', () => {
    const onRequest = vi.fn()
    const unlinkFile = vi
      .fn()
      .mockImplementationOnce(() => {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      })
      .mockImplementationOnce(() => undefined)
      .mockImplementation(() => {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      })
    let notify: (event: string, filename: string | Buffer | null) => void = () => {}
    const watcher = { on: vi.fn(), unref: vi.fn(), close: vi.fn() }
    const watchDirectory = vi.fn((_path, callback) => {
      notify = callback
      return watcher
    })
    const listener = installOrcadStopRequestListener(onRequest, {
      installRoot: 'C:\\orca',
      watchDirectory: watchDirectory as never,
      unlinkFile
    })

    notify('rename', 'unrelated')
    notify('rename', null)
    notify('change', ORCAD_STOP_REQUEST_FILENAME)

    expect(onRequest).toHaveBeenCalledOnce()
    listener.close()
  })

  it('owns watcher errors instead of letting EventEmitter crash the runtime', () => {
    const error = new Error('watch failed')
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    let onError: (candidate: Error) => void = () => {}
    const watcher = {
      on: vi.fn((event: string, listener: (candidate: Error) => void) => {
        if (event === 'error') {
          onError = listener
        }
      }),
      unref: vi.fn(),
      close: vi.fn()
    }

    const listener = installOrcadStopRequestListener(vi.fn(), {
      installRoot: 'C:\\orca',
      watchDirectory: vi.fn(() => watcher) as never,
      unlinkFile: vi.fn(() => {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      })
    })
    onError(error)

    expect(log).toHaveBeenCalledWith('[orcad] stop-request watcher failed:', error)
    listener.close()
  })
})

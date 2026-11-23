import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RuntimeClientConnectionLog } from './runtime-rpc-client-connection-log'

function socket(connectionId: string, deviceId = 'device-a') {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the logger reads only these fields.
  return {
    connectionId,
    device: { deviceId, scope: 'runtime' },
    transport: { transport: 'direct' }
  } as unknown as Parameters<RuntimeClientConnectionLog['record']>[1]
}

describe('RuntimeClientConnectionLog', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('logs a busy CLI device once, then one summary per window, then forgets it when idle', () => {
    const lines: string[] = []
    const log = new RuntimeClientConnectionLog((line) => lines.push(line))

    for (let index = 0; index < 100; index += 1) {
      log.record('connected', socket(`c${index}`))
      log.record('disconnected', socket(`c${index}`))
    }
    vi.advanceTimersByTime(10 * 60_000)
    vi.advanceTimersByTime(10 * 60_000)
    log.record('connected', socket('later'))

    expect(lines).toEqual([
      '[runtime-rpc] client connected device=device-a scope=runtime transport=direct connection=c0',
      '[runtime-rpc] client activity device=device-a scope=runtime transport=direct connected=100 disconnected=100 open=0',
      '[runtime-rpc] client connected device=device-a scope=runtime transport=direct connection=later'
    ])
  })

  it('keeps a long-lived connection quiet until it closes', () => {
    const lines: string[] = []
    const log = new RuntimeClientConnectionLog((line) => lines.push(line))

    log.record('connected', socket('phone', 'device-b'))
    vi.advanceTimersByTime(10 * 60_000)
    vi.advanceTimersByTime(30 * 60_000)
    log.record('disconnected', socket('phone', 'device-b'))
    vi.advanceTimersByTime(10 * 60_000)

    expect(lines).toEqual([
      '[runtime-rpc] client connected device=device-b scope=runtime transport=direct connection=phone',
      '[runtime-rpc] client activity device=device-b scope=runtime transport=direct connected=1 disconnected=0 open=1',
      '[runtime-rpc] client activity device=device-b scope=runtime transport=direct connected=0 disconnected=1 open=0'
    ])
  })

  it('records every attached device on close and ignores the stopped session afterwards', () => {
    const lines: string[] = []
    const log = new RuntimeClientConnectionLog((line) => lines.push(line))

    log.record('connected', socket('phone', 'device-b'))
    vi.advanceTimersByTime(10 * 60_000)
    log.record('connected', socket('cli'))
    log.close()
    // A relay socket from the stopped server closing late is ignored.
    log.record('disconnected', socket('phone', 'device-b'))
    log.record('connected', socket('late'))
    const next = new RuntimeClientConnectionLog((line) => lines.push(line))
    next.record('connected', socket('after-restart'))

    expect(lines).toEqual([
      '[runtime-rpc] client connected device=device-b scope=runtime transport=direct connection=phone',
      '[runtime-rpc] client activity device=device-b scope=runtime transport=direct connected=1 disconnected=0 open=1',
      '[runtime-rpc] client connected device=device-a scope=runtime transport=direct connection=cli',
      '[runtime-rpc] client activity device=device-b scope=runtime transport=direct connected=0 disconnected=0 open=1',
      '[runtime-rpc] client activity device=device-a scope=runtime transport=direct connected=1 disconnected=0 open=1',
      '[runtime-rpc] client connected device=device-a scope=runtime transport=direct connection=after-restart'
    ])
  })
})

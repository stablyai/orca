import { describe, expect, it, vi } from 'vitest'
import { POST_PROOF_CLOSE_LOG_WINDOW_MS, PostProofCloseLog } from './post-proof-close-log.js'

const close = {
  relayHostId: 'abcdefghijklmnop',
  generation: 7,
  appVersion: '1.4.150',
  code: 4409,
  reason: 'assignment changed during host proof',
  cause: 'wrong_assignment' as const
}

function createLog() {
  const lines: string[] = []
  const scheduled: Array<{ callback: () => void; delayMs: number }> = []
  const observer = {
    recordAuth: vi.fn(),
    recordForwardedBytes: vi.fn(),
    recordHttp: vi.fn(),
    recordReconnect: vi.fn(),
    recordSql: vi.fn(),
    recordPostProofClose: vi.fn()
  }
  const log = new PostProofCloseLog(
    observer,
    (line) => lines.push(line),
    (callback, delayMs) => {
      scheduled.push({ callback, delayMs })
      return () => undefined
    }
  )
  return { log, lines, scheduled, observer }
}

describe('post-proof close log', () => {
  it('counts every close but writes one line per reason and cause per window', () => {
    const { log, lines, scheduled, observer } = createLog()
    for (let index = 0; index < 1_000; index++) log.record({ ...close, generation: index })
    log.record({ ...close, cause: 'database_transient' })
    log.record({ ...close, code: 4400, reason: 'relay draining', cause: undefined })

    expect(observer.recordPostProofClose).toHaveBeenCalledTimes(1_002)
    expect(lines).toHaveLength(3)
    expect(scheduled.map((entry) => entry.delayMs)).toEqual(
      Array.from({ length: 3 }, () => POST_PROOF_CLOSE_LOG_WINDOW_MS)
    )

    for (const { callback } of scheduled) callback()
    // Only the window that held closes back writes a closing line, naming the latest.
    expect(lines).toHaveLength(4)
    expect(lines[3]).toContain('gen=999')
    expect(lines[3]).toContain('suppressed=999')
  })

  it('names the host by digest and keeps peer-supplied versions printable', () => {
    const { log, lines } = createLog()
    log.record({ ...close, appVersion: '1.4.150\n\u0007injected' })
    expect(lines[0]).toMatch(
      /^\[orca-relay\] control refused after proof host=\S+ gen=7 app="1\.4\.150injected" code=4409 reason="assignment changed during host proof" cause=wrong_assignment$/
    )
    expect(lines[0]).not.toContain(close.relayHostId)
  })
})

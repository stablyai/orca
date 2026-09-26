import { describe, expect, it } from 'vitest'
import { formatMobileWebShellDevFacts } from './mobile-web-shell-dev-facts'

const READY = { buildId: '0123456789abcdef', totalBytes: 2_097_152, elapsedMs: 412 }
/** The prefix the shell has always shown; this commit moved the line, not what it says. */
const PREFIX = '0123456789ab'

describe('the shell dev facts line', () => {
  it('shows the build prefix, the bytes and the time, and never the whole build id', () => {
    const line = formatMobileWebShellDevFacts({ ...READY, droppedBinaryFrames: 0 })
    expect(line).toBe(`${PREFIX} · 2097152 B · 412 ms`)
    expect(line).not.toContain(READY.buildId)
  })

  /** Absent rather than zero: the line is read at a glance on a device, and a count that is always
   *  there is one nobody notices changing. */
  it('says nothing about dropped frames until one is dropped', () => {
    expect(formatMobileWebShellDevFacts({ ...READY, droppedBinaryFrames: 0 })).not.toContain(
      'dropped'
    )
  })

  it('carries the running dropped-frame count once the stream has shed one', () => {
    expect(formatMobileWebShellDevFacts({ ...READY, droppedBinaryFrames: 1 })).toBe(
      `${PREFIX} · 2097152 B · 412 ms · 1 frame dropped`
    )
    expect(formatMobileWebShellDevFacts({ ...READY, droppedBinaryFrames: 37 })).toBe(
      `${PREFIX} · 2097152 B · 412 ms · 37 frames dropped`
    )
  })
})

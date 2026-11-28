import { describe, expect, it, vi } from 'vitest'

import {
  PRODUCER_FLOW_ACTIVE_HIGH_WATERMARK_CHARS,
  PRODUCER_FLOW_ACTIVE_LOW_WATERMARK_CHARS,
  PRODUCER_FLOW_HIGH_WATERMARK_CHARS,
  PRODUCER_FLOW_LOW_WATERMARK_CHARS,
  PtyProducerFlowController
} from './pty-producer-flow-control'

describe('PtyProducerFlowController watermarks', () => {
  it('allows single large active media frames without pausing while releasing promoted background PTYs', () => {
    const pauseProducer = vi.fn()
    const resumeProducer = vi.fn()
    const controller = new PtyProducerFlowController({ pauseProducer, resumeProducer })

    // Background watermark still pauses at 256KB+ and resumes below 32KB.
    controller.update('bg-pty', PRODUCER_FLOW_HIGH_WATERMARK_CHARS + 1)
    expect(pauseProducer).toHaveBeenCalledTimes(1)
    expect(controller.isPaused('bg-pty')).toBe(true)

    controller.update('bg-pty', PRODUCER_FLOW_LOW_WATERMARK_CHARS - 1)
    expect(resumeProducer).toHaveBeenCalledTimes(1)
    expect(controller.isPaused('bg-pty')).toBe(false)

    // Active watermarks accommodate a 900KB clipped Kitty frame without stalling the producer.
    const activeWatermarks = {
      highWatermarkChars: PRODUCER_FLOW_ACTIVE_HIGH_WATERMARK_CHARS,
      lowWatermarkChars: PRODUCER_FLOW_ACTIVE_LOW_WATERMARK_CHARS
    }
    controller.update('active-pty', 900 * 1024, activeWatermarks)
    expect(controller.isPaused('active-pty')).toBe(false)
    expect(pauseProducer).toHaveBeenCalledTimes(1)

    // Sustained active floods past 1.5MB still pause before reaching the 2MB drop cap.
    controller.update('active-pty', PRODUCER_FLOW_ACTIVE_HIGH_WATERMARK_CHARS + 1, activeWatermarks)
    expect(controller.isPaused('active-pty')).toBe(true)

    // Promoting a previously paused background PTY above 32KB but below active low watermark resumes it.
    controller.update('bg-pty', 300 * 1024)
    expect(controller.isPaused('bg-pty')).toBe(true)
    controller.update('bg-pty', 300 * 1024, activeWatermarks)
    expect(controller.isPaused('bg-pty')).toBe(false)
  })
})

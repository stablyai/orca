import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PRODUCER_PAUSE_FAILSAFE_MS,
  SessionProducerPause,
  STREAM_BACKPRESSURE_STALL_WATCHDOG_MS
} from './session-producer-pause'

function createProducer() {
  const subprocess = { pause: vi.fn(), resume: vi.fn() }
  const onStreamStall = vi.fn()
  return {
    subprocess,
    onStreamStall,
    producer: new SessionProducerPause(subprocess)
  }
}

describe('SessionProducerPause stream stall watchdog', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('resumes the producer and sheds the backlog when the consumer never drains', () => {
    vi.useFakeTimers()
    const { producer, subprocess, onStreamStall } = createProducer()
    producer.pause('stream', true, onStreamStall)
    expect(subprocess.pause).toHaveBeenCalledOnce()

    vi.advanceTimersByTime(STREAM_BACKPRESSURE_STALL_WATCHDOG_MS - 1)
    expect(onStreamStall).not.toHaveBeenCalled()
    expect(subprocess.resume).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    // Shed first: resuming into an unbounded queue would just rebuild the stall.
    expect(onStreamStall).toHaveBeenCalledOnce()
    expect(subprocess.resume).toHaveBeenCalledOnce()
  })

  it('never fires against a session whose consumer is draining', () => {
    vi.useFakeTimers()
    const { producer, subprocess, onStreamStall } = createProducer()
    for (let cycle = 0; cycle < 5; cycle++) {
      producer.pause('stream', true, onStreamStall)
      vi.advanceTimersByTime(STREAM_BACKPRESSURE_STALL_WATCHDOG_MS / 2)
      producer.resumeClient('stream')
      vi.advanceTimersByTime(STREAM_BACKPRESSURE_STALL_WATCHDOG_MS)
    }
    expect(onStreamStall).not.toHaveBeenCalled()
    expect(subprocess.pause).toHaveBeenCalledTimes(5)
    expect(subprocess.resume).toHaveBeenCalledTimes(5)
  })

  it('does not let a re-asserted pause defer the watchdog', () => {
    vi.useFakeTimers()
    const { producer, onStreamStall } = createProducer()
    producer.pause('stream', true, onStreamStall)
    // refresh() re-asserts a standing pause on every enqueue for any session sharing the client.
    for (let tick = 0; tick < 10; tick++) {
      vi.advanceTimersByTime(STREAM_BACKPRESSURE_STALL_WATCHDOG_MS / 10)
      producer.pause('stream', true, onStreamStall)
    }
    expect(onStreamStall).toHaveBeenCalledOnce()
  })

  it.each([
    ['a stream resume', (producer: SessionProducerPause) => producer.resumeClient('stream')],
    ['a release', (producer: SessionProducerPause) => producer.release({ resume: true })],
    [
      'a detach without resume',
      (producer: SessionProducerPause) => producer.release({ resume: false })
    ]
  ])('clears the watchdog on %s', (_label, unpause) => {
    vi.useFakeTimers()
    const { producer, onStreamStall } = createProducer()
    producer.pause('stream', true, onStreamStall)
    unpause(producer)
    vi.advanceTimersByTime(STREAM_BACKPRESSURE_STALL_WATCHDOG_MS * 2)
    expect(onStreamStall).not.toHaveBeenCalled()
  })

  it('leaves an unattached session unarmed — nothing is consuming it', () => {
    vi.useFakeTimers()
    const { producer, subprocess, onStreamStall } = createProducer()
    producer.pause('stream', false, onStreamStall)
    vi.advanceTimersByTime(STREAM_BACKPRESSURE_STALL_WATCHDOG_MS * 2)
    expect(onStreamStall).not.toHaveBeenCalled()
    expect(subprocess.pause).not.toHaveBeenCalled()
  })

  it('keeps an outstanding client pause in force after the stream watchdog fires', () => {
    vi.useFakeTimers()
    const { producer, subprocess, onStreamStall } = createProducer()
    producer.pause('stream', true, onStreamStall)
    producer.pause()
    vi.advanceTimersByTime(PRODUCER_PAUSE_FAILSAFE_MS)
    // The client failsafe cannot resume while the stream still holds the producer.
    expect(subprocess.resume).not.toHaveBeenCalled()
    vi.advanceTimersByTime(STREAM_BACKPRESSURE_STALL_WATCHDOG_MS)
    expect(onStreamStall).toHaveBeenCalledOnce()
    expect(subprocess.resume).toHaveBeenCalledOnce()
  })
})

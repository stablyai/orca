import { expect, it, vi } from 'vitest'
import { createLiveTextPublication } from './structured-agent-session-dispatch'
it('admits no live operations for unobserved streams at N and 10N', () => {
  for (const streams of [100, 1000]) {
    const submit = vi.fn(() => ({ accepted: true as const }))
    let interested = false
    const publish = createLiveTextPublication(
      submit,
      () => null,
      () => [],
      () => interested
    )
    for (let window = 0; window < 100; window++) {
      for (let stream = 0; stream < streams; stream++) {
        publish()
      }
    }
    expect(submit).not.toHaveBeenCalled()
    interested = true
    publish()
    expect(submit).toHaveBeenCalledTimes(1)
  }
})

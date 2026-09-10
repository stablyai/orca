import { describe, expect, it } from 'vitest'
import { inspectLinuxDevGpuOutput } from './linux-dev-gpu-retry.mjs'

describe('Linux dev GPU retry detection', () => {
  it('requests a retry after repeated launch failures split across output chunks', () => {
    const first = inspectLinuxDevGpuOutput('GPU process launch failed: error_code=1002')
    const second = inspectLinuxDevGpuOutput(
      'GPU process launch failed: error_code=1002\nGPU process launch failed: error_code=1002',
      first.failures
    )

    expect(first.retry).toBe(false)
    expect(second).toEqual({ failures: 3, retry: true })
  })

  it('requests a retry immediately for Chromium fatal GPU output', () => {
    expect(inspectLinuxDevGpuOutput("FATAL: GPU process isn't usable. Goodbye.")).toEqual({
      failures: 0,
      retry: true
    })
  })
})

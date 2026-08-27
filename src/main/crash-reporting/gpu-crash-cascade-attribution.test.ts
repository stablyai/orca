import { describe, expect, it } from 'vitest'
import { GpuCrashCascadeAttributor } from './gpu-crash-cascade-attribution'

const startedAt = Date.UTC(2026, 7, 3, 22, 40, 14)

describe('GpuCrashCascadeAttributor', () => {
  it('claims a renderer crash that trails a suppressed GPU crash with the same exit code', () => {
    const attributor = new GpuCrashCascadeAttributor()
    attributor.noteSuppressedGpuCrash({ at: startedAt, exitCode: 3_000 })
    expect(
      attributor.claimRendererCascade({ reason: 'crashed', exitCode: 3_000, at: startedAt + 400 })
    ).toBe(true)
  })

  it('claims at most one cascade per GPU crash', () => {
    const attributor = new GpuCrashCascadeAttributor()
    attributor.noteSuppressedGpuCrash({ at: startedAt, exitCode: null })
    expect(
      attributor.claimRendererCascade({ reason: 'crashed', exitCode: null, at: startedAt + 100 })
    ).toBe(true)
    expect(
      attributor.claimRendererCascade({ reason: 'crashed', exitCode: null, at: startedAt + 200 })
    ).toBe(false)
  })

  it('ignores unrelated renderer deaths', () => {
    const attributor = new GpuCrashCascadeAttributor()
    attributor.noteSuppressedGpuCrash({ at: startedAt, exitCode: 3_000 })
    // Different exit code: a separate fault, not the GPU cascade.
    expect(
      attributor.claimRendererCascade({ reason: 'crashed', exitCode: 5, at: startedAt + 100 })
    ).toBe(false)
    // OOM/killed renderers are their own failure mode.
    expect(
      attributor.claimRendererCascade({
        reason: 'oom',
        exitCode: 3_000,
        at: startedAt + 100
      })
    ).toBe(false)
    // Too late to be the same fault.
    expect(
      attributor.claimRendererCascade({ reason: 'crashed', exitCode: 3_000, at: startedAt + 5_000 })
    ).toBe(false)
  })

  it('never claims without an armed GPU crash', () => {
    const attributor = new GpuCrashCascadeAttributor()
    expect(
      attributor.claimRendererCascade({ reason: 'crashed', exitCode: 3_000, at: startedAt })
    ).toBe(false)
  })

  it('ignores a renderer crash stamped before the GPU crash', () => {
    const attributor = new GpuCrashCascadeAttributor()
    attributor.noteSuppressedGpuCrash({ at: startedAt, exitCode: 3_000 })
    // Why pinned: a backwards clock step must not open an unbounded match window.
    expect(
      attributor.claimRendererCascade({ reason: 'crashed', exitCode: 3_000, at: startedAt - 10_000 })
    ).toBe(false)
  })
})

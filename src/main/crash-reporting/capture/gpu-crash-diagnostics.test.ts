import { describe, expect, it, vi } from 'vitest'
import { GpuCrashDiagnosticsRecorder } from './gpu-crash-diagnostics'

const FEATURE_STATUS = {
  gpu_compositing: 'enabled',
  rasterization: 'enabled',
  webgl: 'enabled',
  webgl2: 'enabled',
  video_decode: 'enabled'
}

describe('GpuCrashDiagnosticsRecorder', () => {
  it('does not let stalled GPU info block crash recovery', async () => {
    const never = Promise.withResolvers<unknown>().promise
    const recordBreadcrumb = vi.fn()
    const provider = {
      getGPUInfo: vi.fn(() => never),
      getGPUFeatureStatus: vi.fn(() => FEATURE_STATUS)
    }
    const recorder = new GpuCrashDiagnosticsRecorder({
      provider,
      recordBreadcrumb,
      recordTimeoutMs: 0
    })

    await recorder.record()

    expect(recordBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({ gpuInfoLevel: 'unavailable' })
    )
  })
})

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { buildGpuCrashDiagnostics, GpuCrashDiagnosticsRecorder } from './gpu-crash-diagnostics'

const FEATURE_STATUS = {
  gpu_compositing: 'enabled',
  rasterization: 'enabled',
  webgl: 'enabled',
  webgl2: 'enabled',
  video_decode: 'enabled'
}

const BASIC_INFO = {
  gpuDevice: [
    {
      active: false,
      vendorId: 0x8086,
      deviceId: 0x9a49,
      vendorString: 'Intel',
      deviceString: 'Integrated GPU'
    },
    {
      active: true,
      vendorId: 0x10de,
      deviceId: 0x2684,
      vendorString: 'NVIDIA',
      deviceString: 'Discrete GPU',
      driverVendor: 'NVIDIA',
      driverVersion: '32.0.15.6094'
    }
  ],
  auxAttributes: {
    glVendor: 'Google Inc.',
    glRenderer: 'ANGLE (NVIDIA, D3D11)',
    glVersion: 'OpenGL ES 3.0'
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolvePromise: ((value: T) => void) | undefined
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve
  })
  return {
    promise,
    resolve: (value) => resolvePromise?.(value)
  }
}

describe('buildGpuCrashDiagnostics', () => {
  it('keeps only the active GPU identity, driver, rendering backend, and feature status', () => {
    expect(
      buildGpuCrashDiagnostics({ info: BASIC_INFO, level: 'complete' }, FEATURE_STATUS)
    ).toEqual({
      gpuInfoLevel: 'complete',
      gpuDeviceCount: 2,
      gpuVendorId: 0x10de,
      gpuDeviceId: 0x2684,
      gpuVendor: 'NVIDIA',
      gpuDevice: 'Discrete GPU',
      gpuDriverVendor: 'NVIDIA',
      gpuDriverVersion: '32.0.15.6094',
      gpuGlVendor: 'Google Inc.',
      gpuGlRenderer: 'ANGLE (NVIDIA, D3D11)',
      gpuGlVersion: 'OpenGL ES 3.0',
      gpuCompositingStatus: 'enabled',
      gpuRasterizationStatus: 'enabled',
      gpuWebglStatus: 'enabled',
      gpuWebgl2Status: 'enabled',
      gpuVideoDecodeStatus: 'enabled'
    })
  })

  it('degrades malformed or unavailable GPU info without copying arbitrary fields', () => {
    expect(
      buildGpuCrashDiagnostics(
        {
          level: 'basic',
          info: {
            gpuDevice: [{ active: true, vendorId: Number.NaN, secret: 'do not copy' }],
            machineModelName: 'do not copy'
          }
        },
        { webgl: 'unavailable', unexpected: 'do not copy' }
      )
    ).toEqual({
      gpuInfoLevel: 'basic',
      gpuDeviceCount: 1,
      gpuWebglStatus: 'unavailable'
    })
    expect(buildGpuCrashDiagnostics(null, null)).toEqual({ gpuInfoLevel: 'unavailable' })
  })
})

describe('GpuCrashDiagnosticsRecorder', () => {
  it('warms only complete info and records one breadcrumb across a crash burst', async () => {
    const recordBreadcrumb = vi.fn()
    const provider = {
      getGPUInfo: vi.fn(async (level: 'basic' | 'complete') => ({
        ...BASIC_INFO,
        gpuDevice: BASIC_INFO.gpuDevice.map((device) => ({
          ...device,
          ...(level === 'complete' ? { driverVersion: 'complete-driver' } : {})
        }))
      })),
      getGPUFeatureStatus: vi.fn(() => FEATURE_STATUS)
    }
    const recorder = new GpuCrashDiagnosticsRecorder({ provider, recordBreadcrumb })

    recorder.warm()
    await vi.waitFor(() => {
      expect(provider.getGPUInfo).toHaveBeenCalledTimes(1)
    })
    await Promise.resolve()
    await recorder.record()
    await recorder.record()

    expect(provider.getGPUInfo).toHaveBeenCalledOnce()
    expect(provider.getGPUInfo).toHaveBeenCalledWith('complete')

    expect(recordBreadcrumb).toHaveBeenCalledTimes(1)
    expect(recordBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        gpuInfoLevel: 'complete',
        gpuVendorId: 0x10de,
        gpuDeviceId: 0x2684,
        gpuDriverVersion: 'complete-driver'
      })
    )
  })

  it('uses promptly available basic info when complete collection is still pending', async () => {
    const complete = deferred<unknown>()
    const recordBreadcrumb = vi.fn()
    const provider = {
      getGPUInfo: vi.fn((level: 'basic' | 'complete') =>
        level === 'basic' ? Promise.resolve(BASIC_INFO) : complete.promise
      ),
      getGPUFeatureStatus: vi.fn(() => FEATURE_STATUS)
    }
    const recorder = new GpuCrashDiagnosticsRecorder({ provider, recordBreadcrumb })

    recorder.warm()
    expect(provider.getGPUInfo).toHaveBeenCalledOnce()
    expect(provider.getGPUInfo).toHaveBeenCalledWith('complete')
    await recorder.record()

    expect(recordBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        gpuInfoLevel: 'basic',
        gpuVendorId: 0x10de,
        gpuDriverVersion: '32.0.15.6094'
      })
    )
    complete.resolve(BASIC_INFO)
  })

  it('shares pending capture work and releases it when complete info arrives first', async () => {
    const complete = deferred<unknown>()
    const basic = deferred<unknown>()
    const recordBreadcrumb = vi.fn()
    const provider = {
      getGPUInfo: vi.fn((level: 'basic' | 'complete') =>
        level === 'basic' ? basic.promise : complete.promise
      ),
      getGPUFeatureStatus: vi.fn(() => FEATURE_STATUS)
    }
    const recorder = new GpuCrashDiagnosticsRecorder({ provider, recordBreadcrumb })

    recorder.warm()
    const first = recorder.record()
    const second = recorder.record()

    expect(second).toBe(first)
    expect(recordBreadcrumb).not.toHaveBeenCalled()
    complete.resolve(BASIC_INFO)
    await first
    expect(recordBreadcrumb).toHaveBeenCalledOnce()
    expect(recordBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({ gpuInfoLevel: 'complete' })
    )
  })

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

  it('still records collection status when Electron throws during both GPU info calls', async () => {
    const recordBreadcrumb = vi.fn()
    const provider = {
      getGPUInfo: vi.fn(() => {
        throw new Error('GPU access disabled')
      }),
      getGPUFeatureStatus: vi.fn(() => {
        throw new Error('GPU teardown')
      })
    }
    const recorder = new GpuCrashDiagnosticsRecorder({ provider, recordBreadcrumb })

    recorder.warm()
    await recorder.record()

    expect(recordBreadcrumb).toHaveBeenCalledWith({ gpuInfoLevel: 'unavailable' })
  })
})

describe('GPU crash diagnostics production wiring', () => {
  it('starts diagnostics without delaying safe-graphics fallback', () => {
    const source = readFileSync(
      join(__dirname, '..', 'startup', 'main-process-preflight.ts'),
      'utf8'
    )
    const listenerSource = readFileSync(
      join(__dirname, '..', 'startup', 'main-process-ready-runtime.ts'),
      'utf8'
    )
    const listenerStart = listenerSource.indexOf("  app.on('child-process-gone'")
    expect(listenerStart).toBeGreaterThan(0)
    const listener = listenerSource.slice(
      listenerStart,
      listenerSource.indexOf('\n  })', listenerStart)
    )
    expect(source).toMatch(
      /recordBreadcrumb: \(data\) =>\s*recordDurableCrashBreadcrumb\('gpu_crash_hardware', data\)/
    )
    expect(listener).toMatch(
      /const crashedAt = performance\.now\(\)[\s\S]*?void state\.gpuCrashDiagnostics\?\.record\(\)[\s\S]*?void handleGpuChildCrash\(details\.reason, details\.exitCode \?\? null, crashedAt\)/
    )
    expect(listener).not.toMatch(/state\.gpuCrashDiagnostics\?\.record\(\)[\s\S]*?\.then\(/)
  })
})

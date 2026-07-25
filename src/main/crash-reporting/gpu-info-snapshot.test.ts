import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  captureGpuInfoSnapshot,
  getGpuInfoSnapshot,
  setGpuInfoSnapshotForTesting,
  summarizeGpuInfo
} from './gpu-info-snapshot'

const COMPLETE_INFO = {
  auxAttributes: {
    glVendor: 'Google Inc. (Intel)',
    glRenderer: 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    glVersion: 'OpenGL ES 2.0.0',
    glImplementation: 'EGL_ANGLE',
    glExtensions: 'GL_EXT_a '.repeat(500),
    basicInfoState: 1,
    contextInfoState: 1,
    initializationTime: 42.5,
    inProcessGpu: false,
    sandboxed: true,
    directComposition: true,
    passthroughCmdDecoder: true
  },
  gpuDevice: [
    { active: false, vendorId: 4318, deviceId: 7938, driverVendor: 'NVIDIA' },
    {
      active: true,
      vendorId: 32902,
      deviceId: 15130,
      driverVendor: 'Intel Corporation',
      driverVersion: '31.0.101.2111',
      deviceString: 'Intel(R) UHD Graphics 620'
    }
  ],
  machineModelName: 'Latitude 5400',
  machineModelVersion: '1.0'
}

describe('summarizeGpuInfo', () => {
  it('flattens the active device and aux attributes', () => {
    const summary = summarizeGpuInfo(COMPLETE_INFO)

    expect(summary).toMatchObject({
      gpuInfoAvailable: true,
      gpuDeviceCount: 2,
      gpuVendorId: '0x8086',
      gpuDeviceId: '0x3b1a',
      gpuDriverVendor: 'Intel Corporation',
      gpuDriverVersion: '31.0.101.2111',
      gpuGlVendor: 'Google Inc. (Intel)',
      gpuAnglePlatform: 'EGL_ANGLE',
      gpuInProcess: false,
      gpuSandboxed: true,
      gpuBasicInfoState: 1,
      gpuInitializationTimeMs: 42.5,
      gpuMachineModel: 'Latitude 5400'
    })
  })

  // Why: glExtensions is kilobytes long and would dominate every crash report.
  it('never copies the extension list and bounds long strings', () => {
    const summary = summarizeGpuInfo(COMPLETE_INFO)

    expect(Object.keys(summary)).not.toContain('gpuGlExtensions')
    for (const value of Object.values(summary)) {
      if (typeof value === 'string') {
        expect(value.length).toBeLessThanOrEqual(160)
      }
    }
  })

  it('falls back to the first device when none is marked active', () => {
    const summary = summarizeGpuInfo({ gpuDevice: [{ vendorId: 4318, deviceId: 7938 }] })
    expect(summary).toMatchObject({ gpuVendorId: '0x10de', gpuDeviceCount: 1 })
  })

  it('reports unavailable for non-object payloads', () => {
    expect(summarizeGpuInfo(null)).toEqual({ gpuInfoAvailable: false })
    expect(summarizeGpuInfo('nope')).toEqual({ gpuInfoAvailable: false })
  })

  it('omits fields the payload does not carry', () => {
    const summary = summarizeGpuInfo({ gpuDevice: [] })
    expect(summary).toEqual({ gpuInfoAvailable: true, gpuDeviceCount: 0 })
  })
})

describe('captureGpuInfoSnapshot', () => {
  afterEach(() => {
    setGpuInfoSnapshotForTesting(null)
    vi.useRealTimers()
  })

  it('caches a successful capture', async () => {
    const snapshot = await captureGpuInfoSnapshot(async () => COMPLETE_INFO, 1_000)
    expect(snapshot.gpuVendorId).toBe('0x8086')
    expect(getGpuInfoSnapshot()).toBe(snapshot)
  })

  it('records the error shape when getGPUInfo rejects', async () => {
    const snapshot = await captureGpuInfoSnapshot(async () => {
      throw new Error('GPU process crashed')
    }, 1_000)
    expect(snapshot).toMatchObject({ gpuInfoAvailable: false, gpuInfoError: 'GPU process crashed' })
    expect(getGpuInfoSnapshot()).toBe(snapshot)
  })

  // Why: on the machines this exists for, the GPU child never initializes and the promise never settles.
  it('times out instead of hanging forever', async () => {
    vi.useFakeTimers()
    const pending = captureGpuInfoSnapshot(() => new Promise(() => {}), 10_000)
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(pending).resolves.toEqual({ gpuInfoAvailable: false, gpuInfoError: 'timeout' })
  })
})

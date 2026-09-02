import { describe, expect, it } from 'vitest'
import {
  createGpuAccelerationAboutPanelOptions,
  describeGpuAcceleration
} from './gpu-acceleration-about-panel'

describe('GPU acceleration About panel', () => {
  it.each([
    ['enabled', 'Enabled'],
    ['disabled_off', 'Disabled'],
    ['disabled_software', 'Software rendering'],
    ['unavailable_software', 'Software rendering'],
    ['unavailable', 'Unavailable'],
    ['undefined', 'Status unavailable']
  ])('describes Chromium compositing status %s', (gpu_compositing, expected) => {
    expect(describeGpuAcceleration({ gpu_compositing }, false)).toBe(expected)
  })

  it('gives Safe Graphics Mode precedence over Chromium status', () => {
    expect(describeGpuAcceleration({ gpu_compositing: 'enabled' }, true)).toBe(
      'Disabled (Safe Graphics Mode)'
    )
  })

  it('reports status as unavailable until Chromium publishes GPU information', () => {
    expect(describeGpuAcceleration(null, false)).toBe('Status unavailable')
  })

  it('uses the Linux-visible copyright field', () => {
    expect(
      createGpuAccelerationAboutPanelOptions({
        appName: 'Orca',
        appVersion: '1.2.3',
        platform: 'linux',
        gpuFallbackActive: false,
        gpuFeatureStatus: { gpu_compositing: 'enabled' }
      })
    ).toEqual({
      applicationName: 'Orca',
      applicationVersion: '1.2.3',
      copyright: 'GPU acceleration: Enabled'
    })
  })

  it.each(['darwin', 'win32'] satisfies NodeJS.Platform[])('uses credits on %s', (platform) => {
    expect(
      createGpuAccelerationAboutPanelOptions({
        appName: 'Orca',
        appVersion: '1.2.3',
        platform,
        gpuFallbackActive: true,
        gpuFeatureStatus: null
      })
    ).toEqual({
      applicationName: 'Orca',
      applicationVersion: '1.2.3',
      credits: 'GPU acceleration: Disabled (Safe Graphics Mode)'
    })
  })
})

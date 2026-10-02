import { describe, expect, it } from 'vitest'
import { probeRendererLaunchCapacity } from './renderer-launch-failure-probe'

describe.skipIf(process.platform === 'win32')('probeRendererLaunchCapacity (real spawn)', () => {
  it('reports ok when the host can start a process', async () => {
    await expect(probeRendererLaunchCapacity()).resolves.toBe('ok')
  })
})

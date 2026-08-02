import { describe, expect, it } from 'vitest'
import { EmulatorSessionRegistry } from './emulator-session-registry'

describe('EmulatorSessionRegistry backend tagging', () => {
  it('round-trips backend kind and stream codec', () => {
    const registry = new EmulatorSessionRegistry()
    registry.registerActive(
      'wt1',
      { deviceUdid: 'emulator-5554', wsUrl: '', streamUrl: '', streamCodec: 'h264' },
      { managed: true, backend: 'android' }
    )
    const session = registry.getSession('emulator-5554')
    expect(session?.backend).toBe('android')
    expect(session?.streamCodec).toBe('h264')
  })

  it('defaults backend to ios and codec to mjpeg when unspecified', () => {
    const registry = new EmulatorSessionRegistry()
    registry.registerActive('wt1', { deviceUdid: 'UDID', wsUrl: '', streamUrl: '' })
    const session = registry.getSession('UDID')
    expect(session?.backend).toBe('ios')
    expect(session?.streamCodec).toBe('mjpeg')
  })

  it('carries streamCodec back through getActiveForWorktree', () => {
    const registry = new EmulatorSessionRegistry()
    registry.registerActive(
      'wt1',
      { deviceUdid: 'd', wsUrl: '', streamUrl: '', streamCodec: 'h264' },
      { backend: 'android' }
    )
    const info = registry.getActiveForWorktree('wt1')
    expect(info?.streamCodec).toBe('h264')
  })
})

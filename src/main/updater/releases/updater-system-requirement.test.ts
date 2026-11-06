import { describe, expect, it } from 'vitest'
import { getUnsupportedSystemUpdate } from './updater-system-requirement'

describe('getUnsupportedSystemUpdate', () => {
  const gated = { version: '1.5.0', minimumSystemVersion: '22.0.0' }

  it('reports a newer release gated above this macOS', () => {
    expect(getUnsupportedSystemUpdate(gated, '1.4.9', 'darwin', '21.6.0')).toEqual({
      version: '1.5.0',
      minimumMacosVersion: '13'
    })
    expect(
      getUnsupportedSystemUpdate(
        { version: '2.0.0', minimumSystemVersion: '25.0.0' },
        '1.4.9',
        'darwin',
        '24.6.0'
      )
    ).toEqual({ version: '2.0.0', minimumMacosVersion: '26' })
  })

  it('ignores releases this Mac can install or that are not newer', () => {
    expect(getUnsupportedSystemUpdate(gated, '1.4.9', 'darwin', '22.0.0')).toBeUndefined()
    expect(getUnsupportedSystemUpdate(gated, '1.5.0', 'darwin', '21.6.0')).toBeUndefined()
    expect(getUnsupportedSystemUpdate(gated, '1.4.9', 'win32', '10.0.22631')).toBeUndefined()
    expect(
      getUnsupportedSystemUpdate({ version: '1.5.0' }, '1.4.9', 'darwin', '21.6.0')
    ).toBeUndefined()
  })
})

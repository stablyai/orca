import { describe, expect, it } from 'vitest'
import { wslMovedDistroVerdict } from './wsl-move-moved-distro-check'

const ubuntu = { id: 'aaaa', distro: 'Ubuntu', version: 2 as const }

describe('wslMovedDistroVerdict (R38)', () => {
  it('concludes nothing when the registry cannot be read', () => {
    expect(wslMovedDistroVerdict(null, 'Ubuntu', 'aaaa')).toBe('unknown')
  })

  it('finds the same distro by name and GUID, or by GUID after a rename', () => {
    expect(wslMovedDistroVerdict([ubuntu], 'ubuntu', '{AAAA}')).toBe('present')
    expect(wslMovedDistroVerdict([{ ...ubuntu, distro: 'Work' }], 'Ubuntu', 'aaaa')).toBe('present')
  })

  it('calls an unregistered distro gone', () => {
    expect(wslMovedDistroVerdict([], 'Ubuntu', 'aaaa')).toBe('gone')
    expect(wslMovedDistroVerdict([{ ...ubuntu, distro: 'Debian', id: 'bbbb' }], 'Ubuntu')).toBe(
      'gone'
    )
  })

  // An export and re-import under the same name gets a new GUID and keeps every file.
  it('concludes nothing from a new GUID under the same name', () => {
    expect(wslMovedDistroVerdict([{ ...ubuntu, id: 'cccc' }], 'Ubuntu', 'aaaa')).toBe('unknown')
  })

  it('cannot tell a re-register without a recorded GUID', () => {
    expect(wslMovedDistroVerdict([{ ...ubuntu, id: 'cccc' }], 'Ubuntu')).toBe('present')
  })
})

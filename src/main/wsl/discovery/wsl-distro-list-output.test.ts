import { describe, expect, it } from 'vitest'
import { filterUserWslDistros, parseWslDistros } from './wsl-distro-list-output'

describe('WSL distro list output', () => {
  it('normalizes NUL-padded output and the default-distro marker', () => {
    expect(parseWslDistros('*\0 \0U\0b\0u\0n\0t\0u\0\r\0\n\0')).toEqual(['Ubuntu'])
  })

  it('excludes Docker-managed distros', () => {
    expect(filterUserWslDistros(['docker-desktop', 'Ubuntu', 'docker-desktop-data'])).toEqual([
      'Ubuntu'
    ])
  })
})

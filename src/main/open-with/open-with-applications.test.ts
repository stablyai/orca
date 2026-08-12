import { describe, expect, it } from 'vitest'
import { sortOpenWithApplications } from './open-with-applications'

const APPS = [
  { id: 'windows:c:\\code.exe', name: 'Visual Studio Code' },
  { id: 'windows:c:\\notepad++.exe', name: 'Notepad++' },
  { id: 'windows:c:\\powerpnt.exe', name: 'Microsoft PowerPoint', isDefault: true },
  { id: 'windows:c:\\cursor.exe', name: 'Cursor' }
]

describe('sortOpenWithApplications', () => {
  it('puts the default first, then sorts by name, when nothing is recent', () => {
    expect(sortOpenWithApplications(APPS, []).map((a) => a.name)).toEqual([
      'Microsoft PowerPoint',
      'Cursor',
      'Notepad++',
      'Visual Studio Code'
    ])
  })

  it('ranks recently used applications ahead of the default', () => {
    const sorted = sortOpenWithApplications(APPS, [
      'windows:c:\\notepad++.exe',
      'windows:c:\\code.exe'
    ])
    expect(sorted.map((a) => a.name)).toEqual([
      'Notepad++',
      'Visual Studio Code',
      'Microsoft PowerPoint',
      'Cursor'
    ])
  })

  it('ignores recent ids that are no longer discovered', () => {
    const sorted = sortOpenWithApplications(APPS, ['windows:c:\\uninstalled.exe'])
    expect(sorted[0].name).toBe('Microsoft PowerPoint')
  })

  it('does not mutate the input array', () => {
    const input = [...APPS]
    sortOpenWithApplications(input, ['windows:c:\\cursor.exe'])
    expect(input).toEqual(APPS)
  })
})

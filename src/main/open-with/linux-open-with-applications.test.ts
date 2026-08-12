import { describe, expect, it } from 'vitest'
import { parseDesktopEntry, parseGioMimeApplications } from './linux-open-with-applications'

describe('parseGioMimeApplications', () => {
  it('extracts the default and registered desktop ids', () => {
    const output = [
      'Default application for “text/markdown”: org.gnome.gedit.desktop',
      'Registered applications:',
      '\tcode.desktop',
      '\torg.gnome.gedit.desktop',
      'Recommended applications:',
      '\torg.gnome.gedit.desktop',
      ''
    ].join('\n')

    expect(parseGioMimeApplications(output)).toEqual({
      defaultDesktopId: 'org.gnome.gedit.desktop',
      desktopIds: ['code.desktop', 'org.gnome.gedit.desktop', 'org.gnome.gedit.desktop']
    })
  })

  it('handles output without a default application line', () => {
    const output = ['Registered applications:', '\tcode.desktop'].join('\n')
    expect(parseGioMimeApplications(output)).toEqual({
      defaultDesktopId: null,
      desktopIds: ['code.desktop']
    })
  })
})

describe('parseDesktopEntry', () => {
  it('reads Name and NoDisplay from the Desktop Entry group only', () => {
    const content = [
      '[Desktop Entry]',
      'Name=Text Editor',
      'NoDisplay=false',
      '[Desktop Action new-window]',
      'Name=New Window'
    ].join('\n')

    expect(parseDesktopEntry(content)).toEqual({ name: 'Text Editor', noDisplay: false })
  })

  it('flags NoDisplay entries', () => {
    const content = ['[Desktop Entry]', 'Name=Hidden Handler', 'NoDisplay=true'].join('\n')
    expect(parseDesktopEntry(content)).toEqual({ name: 'Hidden Handler', noDisplay: true })
  })
})

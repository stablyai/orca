import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  buildLinuxLaunchInvocation,
  parseDesktopEntry,
  parseGioMimeApplications,
  parseLinuxExecTokens
} from './linux-open-with-applications'

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
  it('reads keys from the Desktop Entry group only', () => {
    const content = [
      '[Desktop Entry]',
      'Name=Text Editor',
      'NoDisplay=false',
      'Exec=gedit %U',
      '[Desktop Action new-window]',
      'Name=New Window',
      'Exec=gedit --new-window %U'
    ].join('\n')

    expect(parseDesktopEntry(content)).toEqual({
      name: 'Text Editor',
      noDisplay: false,
      exec: 'gedit %U',
      terminal: false
    })
  })

  it('flags NoDisplay and Terminal entries', () => {
    const content = ['[Desktop Entry]', 'Name=Vim', 'NoDisplay=true', 'Terminal=true'].join('\n')
    expect(parseDesktopEntry(content)).toEqual({
      name: 'Vim',
      noDisplay: true,
      exec: null,
      terminal: true
    })
  })
})

describe('parseLinuxExecTokens', () => {
  it('splits on unquoted whitespace', () => {
    expect(parseLinuxExecTokens('code --new-window %F')).toEqual(['code', '--new-window', '%F'])
  })

  it('keeps double-quoted sections as one token and unescapes inside quotes', () => {
    expect(parseLinuxExecTokens('"/opt/My Editor/editor" --file=%f')).toEqual([
      '/opt/My Editor/editor',
      '--file=%f'
    ])
    expect(parseLinuxExecTokens('app "a \\"b\\" \\$c"')).toEqual(['app', 'a "b" $c'])
  })

  it('returns null for empty or whitespace-only Exec lines', () => {
    expect(parseLinuxExecTokens('')).toBeNull()
    expect(parseLinuxExecTokens('   ')).toBeNull()
  })
})

describe('buildLinuxLaunchInvocation', () => {
  it('substitutes %f with the plain path as its own argv element', () => {
    expect(buildLinuxLaunchInvocation(['gedit', '%f'], '/tmp/a & b.md')).toEqual({
      spawnCmd: 'gedit',
      spawnArgs: ['/tmp/a & b.md']
    })
  })

  it('substitutes %u with a file URI and handles embedded field codes', () => {
    // Computed, not hardcoded: pathToFileURL prefixes the drive on Windows dev machines.
    const expectedUri = pathToFileURL('/tmp/x.html').href
    expect(buildLinuxLaunchInvocation(['browser', '--open=%u'], '/tmp/x.html')).toEqual({
      spawnCmd: 'browser',
      spawnArgs: [`--open=${expectedUri}`]
    })
  })

  it('drops bare %i/%c/%k tokens and keeps %% literal', () => {
    expect(
      buildLinuxLaunchInvocation(['app', '%i', '%c', '--pct=100%%', '%F'], '/tmp/x')
    ).toEqual({
      spawnCmd: 'app',
      spawnArgs: ['--pct=100%', '/tmp/x']
    })
  })

  it('appends the file path when the Exec line has no file field code', () => {
    expect(buildLinuxLaunchInvocation(['xdg-open'], '/tmp/x')).toEqual({
      spawnCmd: 'xdg-open',
      spawnArgs: ['/tmp/x']
    })
  })

  it('returns null when every token drops away', () => {
    expect(buildLinuxLaunchInvocation(['%i'], '/tmp/x')).toBeNull()
  })
})

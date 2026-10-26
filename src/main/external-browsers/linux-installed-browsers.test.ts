import { describe, expect, it } from 'vitest'
import { expandDesktopEntryExec, parseLinuxInstalledBrowsers } from './linux-installed-browsers'

const URL = 'https://example.com/?a=1&b=2'

function desktopFile(lines: string[]): string {
  return ['[Desktop Entry]', 'Type=Application', ...lines, ''].join('\n')
}

function httpsHandler(name: string, exec: string, extraLines: string[] = []): string {
  return desktopFile([
    `Name=${name}`,
    `Exec=${exec}`,
    'MimeType=x-scheme-handler/https;',
    ...extraLines
  ])
}

const CHROME = desktopFile([
  'Name=Google Chrome',
  'Name[de]=Google Chrome (de)',
  'Exec=/usr/bin/google-chrome-stable %U',
  'MimeType=text/html;x-scheme-handler/http;x-scheme-handler/https;',
  '',
  '[Desktop Action new-window]',
  'Name=New Window',
  'Exec=/usr/bin/google-chrome-stable --new-window'
])

describe('parseLinuxInstalledBrowsers', () => {
  it('detects https handlers and launches Exec with the URL', () => {
    const browsers = parseLinuxInstalledBrowsers([{ id: 'google-chrome.desktop', text: CHROME }])

    expect(browsers.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: 'google-chrome.desktop', name: 'Google Chrome' }
    ])
    expect(browsers[0].launchCommand(URL)).toEqual({
      program: '/usr/bin/google-chrome-stable',
      args: [URL]
    })
  })

  it('skips hidden, NoDisplay, terminal, and non-https entries', () => {
    const browsers = parseLinuxInstalledBrowsers([
      { id: 'hidden.desktop', text: httpsHandler('Hidden', 'hidden %u', ['Hidden=true']) },
      { id: 'nodisplay.desktop', text: httpsHandler('NoDisplay', 'nodisplay', ['NoDisplay=true']) },
      { id: 'w3m.desktop', text: httpsHandler('w3m', 'w3m %u', ['Terminal=true']) },
      {
        id: 'editor.desktop',
        text: desktopFile(['Name=Editor', 'Exec=editor %F', 'MimeType=x-scheme-handler/http;'])
      }
    ])

    expect(browsers).toEqual([])
  })

  it('lets a user-dir entry override a system entry with the same id', () => {
    const browsers = parseLinuxInstalledBrowsers([
      { id: 'firefox.desktop', text: httpsHandler('My Firefox', '/opt/firefox/firefox %u') },
      { id: 'firefox.desktop', text: httpsHandler('Firefox', '/usr/bin/firefox %u') },
      { id: 'google-chrome.desktop', text: desktopFile(['Name=Hidden Chrome', 'Hidden=true']) },
      { id: 'google-chrome.desktop', text: CHROME }
    ])

    expect(browsers.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: 'firefox.desktop', name: 'My Firefox' }
    ])
    expect(browsers[0].launchCommand(URL).program).toBe('/opt/firefox/firefox')
  })
})

describe('expandDesktopEntryExec', () => {
  it('drops %i and %c field codes and keeps quoted args', () => {
    expect(
      expandDesktopEntryExec('"/opt/My Browser/browser" --profile "Work \\"A\\"" %i %c %u', URL)
    ).toEqual(['/opt/My Browser/browser', '--profile', 'Work "A"', URL])
  })

  it('keeps flatpak forwarding markers around the URL', () => {
    expect(
      expandDesktopEntryExec(
        '/usr/bin/flatpak run --command=firefox --file-forwarding org.mozilla.firefox @@u %u @@',
        URL
      )
    ).toEqual([
      '/usr/bin/flatpak',
      'run',
      '--command=firefox',
      '--file-forwarding',
      'org.mozilla.firefox',
      '@@u',
      URL,
      '@@'
    ])
  })

  it('appends the URL when Exec has no URL field code', () => {
    expect(expandDesktopEntryExec('browser --new-window', URL)).toEqual([
      'browser',
      '--new-window',
      URL
    ])
  })
})

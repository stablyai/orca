import { describe, expect, it } from 'vitest'
import {
  parseWindowsBrowserExecutable,
  parseWindowsInstalledBrowsers
} from './windows-installed-browsers'

const HKLM_OUTPUT = [
  '',
  'HKEY_LOCAL_MACHINE\\SOFTWARE\\Clients\\StartMenuInternet\\Google Chrome',
  '    (Default)    REG_SZ    Google Chrome',
  '',
  'HKEY_LOCAL_MACHINE\\SOFTWARE\\Clients\\StartMenuInternet\\Google Chrome\\Capabilities',
  '    ApplicationName    REG_SZ    Google Chrome',
  '',
  'HKEY_LOCAL_MACHINE\\SOFTWARE\\Clients\\StartMenuInternet\\Google Chrome\\shell\\open\\command',
  '    (Default)    REG_SZ    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"',
  '',
  'HKEY_LOCAL_MACHINE\\SOFTWARE\\Clients\\StartMenuInternet\\Microsoft Edge',
  '    (Default)    REG_SZ    Microsoft Edge',
  '',
  'HKEY_LOCAL_MACHINE\\SOFTWARE\\Clients\\StartMenuInternet\\Microsoft Edge\\shell\\open\\command',
  '    (Default)    REG_SZ    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"',
  '',
  'HKEY_LOCAL_MACHINE\\SOFTWARE\\Clients\\StartMenuInternet\\Firefox-308046B0AF4A39CB',
  '    (Default)    REG_SZ    Mozilla Firefox (machine)',
  '',
  'HKEY_LOCAL_MACHINE\\SOFTWARE\\Clients\\StartMenuInternet\\Firefox-308046B0AF4A39CB\\shell\\open\\command',
  '    (Default)    REG_SZ    "C:\\Program Files\\Mozilla Firefox\\firefox.exe"',
  ''
].join('\r\n')

// Localized default-value name: reg.exe prints "(Standard)" on German Windows.
const HKCU_OUTPUT = [
  '',
  'HKEY_CURRENT_USER\\SOFTWARE\\Clients\\StartMenuInternet\\Firefox-308046B0AF4A39CB',
  '    (Standard)    REG_SZ    Mozilla Firefox',
  '',
  'HKEY_CURRENT_USER\\SOFTWARE\\Clients\\StartMenuInternet\\Firefox-308046B0AF4A39CB\\shell\\open\\command',
  '    (Standard)    REG_EXPAND_SZ    "%LOCALAPPDATA%\\Mozilla Firefox\\firefox.exe" -osint -url "%1"',
  ''
].join('\r\n')

const ENV = { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }

function summarize(
  browsers: ReturnType<typeof parseWindowsInstalledBrowsers>
): { id: string; name: string; executable: string }[] {
  return browsers.map((browser) => ({
    id: browser.id,
    name: browser.name,
    executable: browser.launchCommand('https://example.com').program
  }))
}

describe('parseWindowsInstalledBrowsers', () => {
  it('merges hives with HKCU winning on a duplicate key', () => {
    const browsers = parseWindowsInstalledBrowsers([HKCU_OUTPUT, HKLM_OUTPUT, null], ENV)

    expect(summarize(browsers)).toEqual([
      {
        id: 'Firefox-308046B0AF4A39CB',
        name: 'Mozilla Firefox',
        executable: 'C:\\Users\\me\\AppData\\Local\\Mozilla Firefox\\firefox.exe'
      },
      {
        id: 'Google Chrome',
        name: 'Google Chrome',
        executable: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
      },
      {
        id: 'Microsoft Edge',
        name: 'Microsoft Edge',
        executable: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
      }
    ])
  })

  it('launches the executable with the URL as its own argument', () => {
    const [chrome] = parseWindowsInstalledBrowsers([HKLM_OUTPUT], ENV)
    expect(chrome.launchCommand('https://example.com/?a=1&b=2')).toEqual({
      program: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      args: ['https://example.com/?a=1&b=2']
    })
  })

  it('yields an empty list when every reg query failed', () => {
    expect(parseWindowsInstalledBrowsers([null, null, null], ENV)).toEqual([])
  })
})

describe('parseWindowsBrowserExecutable', () => {
  it.each([
    ['"C:\\Program Files\\Web\\web.exe" "%1"', 'C:\\Program Files\\Web\\web.exe'],
    ['C:\\Program Files\\Web\\web.exe --flag %1', 'C:\\Program Files\\Web\\web.exe'],
    ['"browser.exe"', null],
    ['(value not set)', null]
  ])('parses %s', (command, expected) => {
    expect(parseWindowsBrowserExecutable(command, ENV)).toBe(expected)
  })
})

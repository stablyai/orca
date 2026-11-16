import { describe, expect, it } from 'vitest'
import { resolveTerminalBrowserCommand } from './terminal-browser-command'

describe('resolveTerminalBrowserCommand', () => {
  it.each([
    [
      '/Applications/Orca.app/Contents/Resources/bin/orca',
      'darwin',
      '/Applications/Orca.app/Contents/Resources/bin/orca'
    ],
    ['/home/dev/.orca/cli/bin/orca', 'linux', '/home/dev/.orca/cli/bin/orca'],
    ['C:\\Orca\\resources\\bin\\orca.exe', 'win32', 'C:\\Orca\\resources\\bin\\orca.exe'],
    ['/Users/dev/Library/Application Support/orca-dev/cli/bin/orca-dev', 'darwin', 'orca-dev'],
    ['/home/dev/a:b/cli/bin/orca', 'linux', 'orca'],
    ['C:\\Users\\First Last\\AppData\\Roaming\\Orca\\cli\\bin\\orca.exe', 'win32', 'orca.exe'],
    [null, 'linux', 'orca']
  ] as const)('gives BROWSER one executable for %s', (launcher, platform, expected) => {
    expect(resolveTerminalBrowserCommand(launcher, platform)).toBe(expected)
  })
})

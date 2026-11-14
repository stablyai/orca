import { describe, expect, it } from 'vitest'
import { argvRequestsServeMode, normalizeServeModeArgv } from './serve-mode-argv'

describe('serve-mode-argv', () => {
  it('refuses a help launch instead of binding a server', () => {
    // Help once launched a network-exposed pairing server silently; route CLI-form help to the CLI.
    for (const argv of [
      ['/AppRun', 'serve', '--help'],
      ['/AppRun', 'serve', '-h'],
      ['/AppRun', '--help', 'serve'],
      ['/AppRun', 'help', 'serve'],
      ['/AppRun', 'serve', 'help']
    ]) {
      expect(argvRequestsServeMode(argv), argv.join(' ')).toBe(false)
      expect(normalizeServeModeArgv(argv)).toEqual(argv)
    }
    // A value named help is not a help request.
    expect(argvRequestsServeMode(['/AppRun', 'serve', '--project-root', 'help'])).toBe(true)
    // Never reinterpret tokens after the operator's -- terminator.
    expect(argvRequestsServeMode(['/AppRun', 'serve', '--', '--help'])).toBe(true)
  })
})

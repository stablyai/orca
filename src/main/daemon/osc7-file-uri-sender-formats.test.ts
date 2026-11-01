import { describe, expect, it } from 'vitest'
import {
  parseFileUriPath,
  parseFileUriPathParts,
  type ParseFileUriPathOptions
} from './osc7-file-uri'
import {
  OSC7_KEEPS_FOLDER,
  OSC7_PARSER_AGREEMENT_CASES
} from '../../shared/osc7-parser-agreement-cases'
import { TerminalOscCwdTitleScanner } from './terminal-osc-cwd-title-scanner'

const FLAVORS: Record<string, ParseFileUriPathOptions> = {
  posix: { pathFlavor: 'posix' },
  win32: { pathFlavor: 'win32' },
  'win32-remote': { pathFlavor: 'win32', remotePosixAuthority: true },
  wsl: { wslDistro: 'Ubuntu' }
}

// Captured from the parser before it tolerated raw delimiters; every existing sender must parse
// byte-identically. Covers our bash/zsh/fish/sh reports, Windows drive forms, empty, localhost and
// real hosts, already-encoded %23/%3F/%25, non-UTF-8 sequences, dot segments and non-file input.
const EXISTING_SENDERS: [string, string, { path: string; hostname: string } | null][] = [
  ['posix', 'file:///home/me/repo', { path: '/home/me/repo', hostname: '' }],
  ['posix', 'file:///home/me/a%20b%20%C3%A9%25%23%3F', { path: '/home/me/a b é%#?', hostname: '' }],
  [
    'posix',
    'file:///home/me/%7Etilde~/dot.dir/-x_y',
    { path: '/home/me/~tilde~/dot.dir/-x_y', hostname: '' }
  ],
  ['posix', 'file:///C:/Users/me/repo', { path: '/C:/Users/me/repo', hostname: '' }],
  ['posix', 'file:///c:/Users/me/repo', { path: '/c:/Users/me/repo', hostname: '' }],
  ['posix', 'file://C:/Users/me/repo', { path: '/C:/Users/me/repo', hostname: '' }],
  ['posix', 'file:///C|/Users/me/repo', { path: '/C:/Users/me/repo', hostname: '' }],
  ['posix', 'file:///C:/Users/me/a%20b', { path: '/C:/Users/me/a b', hostname: '' }],
  ['posix', 'file://localhost/home/me/repo', { path: '/home/me/repo', hostname: '' }],
  ['posix', 'file://DESKTOP-ABC/home/me/repo', { path: '/home/me/repo', hostname: 'desktop-abc' }],
  [
    'posix',
    'file://desktop-abc.localdomain/home/me/repo',
    { path: '/home/me/repo', hostname: 'desktop-abc.localdomain' }
  ],
  ['posix', 'file://192.168.1.10/srv/share', { path: '/srv/share', hostname: '192.168.1.10' }],
  ['posix', 'file://fileserver/share/dir', { path: '/share/dir', hostname: 'fileserver' }],
  ['posix', 'file:///tmp/%23hash%3Fq%25pct', { path: '/tmp/#hash?q%pct', hostname: '' }],
  ['posix', 'file:///tmp/%41encoded', { path: '/tmp/Aencoded', hostname: '' }],
  ['posix', 'file:///tmp/%FF', null],
  ['posix', 'file:///tmp/%C3', null],
  ['posix', 'file:///tmp/%E9t%E9', null],
  ['posix', 'file:///home/me/repo/../other/./x', { path: '/home/me/other/x', hostname: '' }],
  ['posix', 'file:///home/me/%2e%2e/up', { path: '/home/up', hostname: '' }],
  ['posix', 'file:///home\\me\\repo', { path: '/home/me/repo', hostname: '' }],
  ['posix', 'http://host/x', null],
  ['posix', 'file:', { path: '/', hostname: '' }],
  ['posix', 'not a uri', null],
  ['posix', 'file:///', { path: '/', hostname: '' }],
  ['win32', 'file:///home/me/repo', { path: '/home/me/repo', hostname: '' }],
  ['win32', 'file:///home/me/a%20b%20%C3%A9%25%23%3F', { path: '/home/me/a b é%#?', hostname: '' }],
  [
    'win32',
    'file:///home/me/%7Etilde~/dot.dir/-x_y',
    { path: '/home/me/~tilde~/dot.dir/-x_y', hostname: '' }
  ],
  ['win32', 'file:///C:/Users/me/repo', { path: 'C:/Users/me/repo', hostname: '' }],
  ['win32', 'file:///c:/Users/me/repo', { path: 'c:/Users/me/repo', hostname: '' }],
  ['win32', 'file://C:/Users/me/repo', { path: 'C:/Users/me/repo', hostname: '' }],
  ['win32', 'file:///C|/Users/me/repo', { path: 'C:/Users/me/repo', hostname: '' }],
  ['win32', 'file:///C:/Users/me/a%20b', { path: 'C:/Users/me/a b', hostname: '' }],
  ['win32', 'file://localhost/home/me/repo', { path: '/home/me/repo', hostname: '' }],
  [
    'win32',
    'file://DESKTOP-ABC/home/me/repo',
    { path: '\\\\desktop-abc\\home\\me\\repo', hostname: 'desktop-abc' }
  ],
  [
    'win32',
    'file://desktop-abc.localdomain/home/me/repo',
    { path: '\\\\desktop-abc.localdomain\\home\\me\\repo', hostname: 'desktop-abc.localdomain' }
  ],
  [
    'win32',
    'file://192.168.1.10/srv/share',
    { path: '\\\\192.168.1.10\\srv\\share', hostname: '192.168.1.10' }
  ],
  [
    'win32',
    'file://fileserver/share/dir',
    { path: '\\\\fileserver\\share\\dir', hostname: 'fileserver' }
  ],
  ['win32', 'file:///tmp/%23hash%3Fq%25pct', { path: '/tmp/#hash?q%pct', hostname: '' }],
  ['win32', 'file:///tmp/%41encoded', { path: '/tmp/Aencoded', hostname: '' }],
  ['win32', 'file:///tmp/%FF', null],
  ['win32', 'file:///tmp/%C3', null],
  ['win32', 'file:///tmp/%E9t%E9', null],
  ['win32', 'file:///home/me/repo/../other/./x', { path: '/home/me/other/x', hostname: '' }],
  ['win32', 'file:///home/me/%2e%2e/up', { path: '/home/up', hostname: '' }],
  ['win32', 'file:///home\\me\\repo', { path: '/home/me/repo', hostname: '' }],
  ['win32', 'http://host/x', null],
  ['win32', 'file:', { path: '/', hostname: '' }],
  ['win32', 'not a uri', null],
  ['win32', 'file:///', { path: '/', hostname: '' }],
  ['win32-remote', 'file:///home/me/repo', { path: '/home/me/repo', hostname: '' }],
  [
    'win32-remote',
    'file:///home/me/a%20b%20%C3%A9%25%23%3F',
    { path: '/home/me/a b é%#?', hostname: '' }
  ],
  [
    'win32-remote',
    'file:///home/me/%7Etilde~/dot.dir/-x_y',
    { path: '/home/me/~tilde~/dot.dir/-x_y', hostname: '' }
  ],
  ['win32-remote', 'file:///C:/Users/me/repo', { path: 'C:/Users/me/repo', hostname: '' }],
  ['win32-remote', 'file:///c:/Users/me/repo', { path: 'c:/Users/me/repo', hostname: '' }],
  ['win32-remote', 'file://C:/Users/me/repo', { path: 'C:/Users/me/repo', hostname: '' }],
  ['win32-remote', 'file:///C|/Users/me/repo', { path: 'C:/Users/me/repo', hostname: '' }],
  ['win32-remote', 'file:///C:/Users/me/a%20b', { path: 'C:/Users/me/a b', hostname: '' }],
  ['win32-remote', 'file://localhost/home/me/repo', { path: '/home/me/repo', hostname: '' }],
  [
    'win32-remote',
    'file://DESKTOP-ABC/home/me/repo',
    { path: '/home/me/repo', hostname: 'desktop-abc' }
  ],
  [
    'win32-remote',
    'file://desktop-abc.localdomain/home/me/repo',
    { path: '/home/me/repo', hostname: 'desktop-abc.localdomain' }
  ],
  [
    'win32-remote',
    'file://192.168.1.10/srv/share',
    { path: '/srv/share', hostname: '192.168.1.10' }
  ],
  ['win32-remote', 'file://fileserver/share/dir', { path: '/share/dir', hostname: 'fileserver' }],
  ['win32-remote', 'file:///tmp/%23hash%3Fq%25pct', { path: '/tmp/#hash?q%pct', hostname: '' }],
  ['win32-remote', 'file:///tmp/%41encoded', { path: '/tmp/Aencoded', hostname: '' }],
  ['win32-remote', 'file:///tmp/%FF', null],
  ['win32-remote', 'file:///tmp/%C3', null],
  ['win32-remote', 'file:///tmp/%E9t%E9', null],
  ['win32-remote', 'file:///home/me/repo/../other/./x', { path: '/home/me/other/x', hostname: '' }],
  ['win32-remote', 'file:///home/me/%2e%2e/up', { path: '/home/up', hostname: '' }],
  ['win32-remote', 'file:///home\\me\\repo', { path: '/home/me/repo', hostname: '' }],
  ['win32-remote', 'http://host/x', null],
  ['win32-remote', 'file:', { path: '/', hostname: '' }],
  ['win32-remote', 'not a uri', null],
  ['win32-remote', 'file:///', { path: '/', hostname: '' }],
  [
    'wsl',
    'file:///home/me/repo',
    { path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo', hostname: '' }
  ],
  [
    'wsl',
    'file:///home/me/a%20b%20%C3%A9%25%23%3F',
    { path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\a b é%#?', hostname: '' }
  ],
  [
    'wsl',
    'file:///home/me/%7Etilde~/dot.dir/-x_y',
    { path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\~tilde~\\dot.dir\\-x_y', hostname: '' }
  ],
  [
    'wsl',
    'file:///C:/Users/me/repo',
    { path: '\\\\wsl.localhost\\Ubuntu\\C:\\Users\\me\\repo', hostname: '' }
  ],
  [
    'wsl',
    'file:///c:/Users/me/repo',
    { path: '\\\\wsl.localhost\\Ubuntu\\c:\\Users\\me\\repo', hostname: '' }
  ],
  [
    'wsl',
    'file://C:/Users/me/repo',
    { path: '\\\\wsl.localhost\\Ubuntu\\C:\\Users\\me\\repo', hostname: '' }
  ],
  [
    'wsl',
    'file:///C|/Users/me/repo',
    { path: '\\\\wsl.localhost\\Ubuntu\\C:\\Users\\me\\repo', hostname: '' }
  ],
  [
    'wsl',
    'file:///C:/Users/me/a%20b',
    { path: '\\\\wsl.localhost\\Ubuntu\\C:\\Users\\me\\a b', hostname: '' }
  ],
  [
    'wsl',
    'file://localhost/home/me/repo',
    { path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo', hostname: '' }
  ],
  [
    'wsl',
    'file://DESKTOP-ABC/home/me/repo',
    { path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo', hostname: 'desktop-abc' }
  ],
  [
    'wsl',
    'file://desktop-abc.localdomain/home/me/repo',
    { path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo', hostname: 'desktop-abc.localdomain' }
  ],
  [
    'wsl',
    'file://192.168.1.10/srv/share',
    { path: '\\\\wsl.localhost\\Ubuntu\\srv\\share', hostname: '192.168.1.10' }
  ],
  [
    'wsl',
    'file://fileserver/share/dir',
    { path: '\\\\wsl.localhost\\Ubuntu\\share\\dir', hostname: 'fileserver' }
  ],
  [
    'wsl',
    'file:///tmp/%23hash%3Fq%25pct',
    { path: '\\\\wsl.localhost\\Ubuntu\\tmp\\#hash?q%pct', hostname: '' }
  ],
  [
    'wsl',
    'file:///tmp/%41encoded',
    { path: '\\\\wsl.localhost\\Ubuntu\\tmp\\Aencoded', hostname: '' }
  ],
  ['wsl', 'file:///tmp/%FF', null],
  ['wsl', 'file:///tmp/%C3', null],
  ['wsl', 'file:///tmp/%E9t%E9', null],
  [
    'wsl',
    'file:///home/me/repo/../other/./x',
    { path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\other\\x', hostname: '' }
  ],
  [
    'wsl',
    'file:///home/me/%2e%2e/up',
    { path: '\\\\wsl.localhost\\Ubuntu\\home\\up', hostname: '' }
  ],
  [
    'wsl',
    'file:///home\\me\\repo',
    { path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo', hostname: '' }
  ],
  ['wsl', 'http://host/x', null],
  ['wsl', 'file:', { path: '\\\\wsl.localhost\\Ubuntu\\', hostname: '' }],
  ['wsl', 'not a uri', null],
  ['wsl', 'file:///', { path: '\\\\wsl.localhost\\Ubuntu\\', hostname: '' }]
]

describe('OSC 7 file URIs from existing senders', () => {
  it.each(EXISTING_SENDERS)('%s %s', (flavor, uri, expected) => {
    expect(parseFileUriPathParts(uri, FLAVORS[flavor])).toEqual(expected)
  })
})

// The OSC 7 scanner ends a report at BEL or ESC, so raw ESC/BEL never reach this parser.
describe('OSC 7 file URIs with control bytes', () => {
  it.each([
    // NUL, raw or encoded, is refused: no path holds one, node-pty truncates at it, execFile throws.
    ['file:///tmp/%00x', null],
    ['file:///tmp/a\u0000b', null],
    // Other control characters are legal in a folder name and decode as before.
    ['file:///tmp/%01x', '/tmp/\u0001x'],
    ['file:///tmp/%0Ax', '/tmp/\nx'],
    ['file:///tmp/%1Bx', '/tmp/\u001bx'],
    ['file:///tmp/%7Fx', '/tmp/\u007fx'],
    // A raw tab is kept, not stripped by the URL parser into another folder's name.
    ['file:///tmp/a\tb', '/tmp/a\tb']
  ])('%j', (uri, path) => {
    expect(parseFileUriPathParts(uri, { pathFlavor: 'posix' })?.path ?? null).toBe(path)
  })
})

// nushell (0.94+, osc7 on by default) percent-encodes only non-ASCII bytes and sends the rest raw.
describe('OSC 7 file URIs from nushell', () => {
  it.each([
    ['a space', 'file://Desktop/home/me/a b', '/home/me/a b'],
    ['non-ASCII', 'file://Desktop/home/me/%C3%A9t%C3%A9', '/home/me/été'],
    ['a lone %', 'file://Desktop/home/me/100%', '/home/me/100%'],
    ['a % before non-hex', 'file://Desktop/home/me/%zz', '/home/me/%zz'],
    ['a #', 'file://Desktop/home/me/h#a', '/home/me/h#a'],
    ['a ?', 'file://Desktop/home/me/wh?y', '/home/me/wh?y'],
    ['everything at once', 'file://Desktop/tmp/a b %C3%A9%#?', '/tmp/a b é%#?']
  ])('keeps %s in the folder', (_case, uri, path) => {
    expect(parseFileUriPathParts(uri, { pathFlavor: 'posix' })).toEqual({
      path,
      hostname: 'desktop'
    })
  })

  it('maps a raw WSL report to the distro path', () => {
    expect(parseFileUriPathParts('file://Desktop/tmp/h#a?b 100%', { wslDistro: 'Ubuntu' })).toEqual(
      {
        path: '\\\\wsl.localhost\\Ubuntu\\tmp\\h#a?b 100%',
        hostname: 'desktop'
      }
    )
  })
})

describe('OSC 7 file URIs both parsers must agree on (daemon side)', () => {
  it.each(OSC7_PARSER_AGREEMENT_CASES)('$name, as a payload', ({ uri, folder }) => {
    expect(parseFileUriPath(uri, { pathFlavor: 'posix' })).toBe(folder)
  })

  // Real traffic: the daemon tracks the pane's folder from raw PTY bytes through this scanner.
  it.each(OSC7_PARSER_AGREEMENT_CASES)(
    '$name, through the PTY scanner',
    ({ uri, folder, viaScanner }) => {
      const scanner = new TerminalOscCwdTitleScanner({ pathFlavor: 'posix' })
      scanner.scan('\x1b]7;file:///before\x07')
      scanner.scan(`\x1b]7;${uri}\x07`)
      const kept = viaScanner === OSC7_KEEPS_FOLDER || folder === null
      expect(scanner.cwd).toBe(kept ? '/before' : folder)
    }
  )
})

import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  codexHookSourcePathsEqual,
  computeTrustKey,
  normalizeCodexHookSourcePath,
  normalizeHookTrustKeyForLookup,
  type CodexTrustEntry
} from './config-toml-trust'

function entry(sourcePath: string): CodexTrustEntry {
  return {
    sourcePath,
    eventLabel: 'stop',
    groupIndex: 2,
    handlerIndex: 3,
    command: 'irrelevant'
  }
}

describe('Codex hook trust source path normalization', () => {
  it.each([
    ['C:/Users/Rod/.codex/./hooks.json', 'C:\\Users\\Rod\\.codex\\hooks.json'],
    ['C:\\Users\\Rod\\tmp\\..\\.codex\\hooks.json', 'C:\\Users\\Rod\\.codex\\hooks.json'],
    ['C:\\Users\\Rod\\.codex\\hooks.json\\', 'C:\\Users\\Rod\\.codex\\hooks.json'],
    ['\\\\server\\share\\dir\\.\\hooks.json', '\\\\server\\share\\dir\\hooks.json'],
    ['\\\\?\\C:\\Users\\Rod\\.codex\\hooks.json', 'C:\\Users\\Rod\\.codex\\hooks.json'],
    ['\\\\?\\UNC\\server\\share\\dir\\hooks.json', '\\\\server\\share\\dir\\hooks.json'],
    ['\\\\.\\C:\\Users\\Rod\\.codex\\hooks.json', 'C:\\Users\\Rod\\.codex\\hooks.json'],
    ['\\\\.\\UNC\\server\\share\\dir\\hooks.json', '\\\\server\\share\\dir\\hooks.json']
  ])('matches Windows PathBuf display semantics for %s', (sourcePath, expected) => {
    expect(normalizeCodexHookSourcePath(sourcePath)).toBe(expected)
  })

  it('uses native semantics for the otherwise ambiguous forward-slash UNC form', () => {
    expect(normalizeCodexHookSourcePath('//server/share/dir/hooks.json')).toBe(
      process.platform === 'win32'
        ? '\\\\server\\share\\dir\\hooks.json'
        : '/server/share/dir/hooks.json'
    )
  })

  it.skipIf(process.platform === 'win32')(
    'normalizes POSIX doubles, dot segments, repeated separators, and trailing slashes',
    () => {
      expect(normalizeCodexHookSourcePath('//tmp/a//b/../hooks.json/')).toBe('/tmp/a/hooks.json')
    }
  )

  it('resolves relative native paths to the absolute discovery shape', () => {
    expect(normalizeCodexHookSourcePath('relative/../hooks.json')).toBe(resolve('hooks.json'))
  })

  it('preserves POSIX case, literal backslashes, spaces, and Unicode bytes', () => {
    const sourcePath = '/tmp/Üser Name/e\u0301\\literal/Hooks.JSON'
    expect(normalizeCodexHookSourcePath(sourcePath)).toBe(sourcePath)
  })

  it('preserves Windows drive-letter and component casing in the lexical path', () => {
    expect(normalizeCodexHookSourcePath('d:/Üser Name/Codex/Hooks.JSON')).toBe(
      'd:\\Üser Name\\Codex\\Hooks.JSON'
    )
  })

  it('builds the key byte-for-byte from the normalized source and positional suffix', () => {
    expect(computeTrustKey(entry('C:/Users/Rod/.codex/../.codex/hooks.json'))).toBe(
      'C:\\Users\\Rod\\.codex\\hooks.json:stop:2:3'
    )
  })
})

describe('Codex hook trust key lookup normalization', () => {
  it('compares mixed-case Windows hook sources by lookup identity', () => {
    expect(
      codexHookSourcePathsEqual(
        'C:\\Users\\Rod\\AppData\\Roaming\\orca\\hooks.json',
        'c:/users/rod/appdata/roaming/orca/hooks.json'
      )
    ).toBe(true)
    expect(codexHookSourcePathsEqual('/home/User/hooks.json', '/home/user/hooks.json')).toBe(false)
    expect(
      codexHookSourcePathsEqual(
        '\\\\wsl.localhost\\Ubuntu\\home\\User\\.codex\\hooks.json',
        '//wsl$/ubuntu/home/User/.codex/hooks.json'
      )
    ).toBe(true)
    expect(
      codexHookSourcePathsEqual(
        '\\\\wsl.localhost\\Ubuntu\\home\\User\\.codex\\hooks.json',
        '//wsl$/ubuntu/home/user/.codex/hooks.json'
      )
    ).toBe(false)
  })

  it('folds Windows separator and case variants without changing the persisted key', () => {
    const native = 'C:\\Users\\Rod\\.codex\\hooks.json:stop:2:3'
    const slash = 'c:/users/rod/.codex/hooks.json:stop:2:3'
    expect(normalizeHookTrustKeyForLookup(native)).toBe(normalizeHookTrustKeyForLookup(slash))
  })

  it('keeps POSIX paths case-sensitive', () => {
    const upper = '/home/Üser/.codex/hooks.json:stop:2:3'
    const lower = '/home/üser/.codex/hooks.json:stop:2:3'
    expect(normalizeHookTrustKeyForLookup(upper)).not.toBe(normalizeHookTrustKeyForLookup(lower))
  })
})

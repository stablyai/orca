import { afterEach, describe, expect, it } from 'vitest'
import {
  classifyLineEndingSample,
  LINE_ENDING_SAMPLE_LIMIT,
  parseHostAutocrlf,
  recordHostAutocrlf,
  recordLineEndingSample,
  resetWslWindowsCheckoutGitConfigForTests,
  UNPROVEN_CHECKOUT_WRITE_GIT_CONFIG_ARGS,
  usesWindowsCheckoutGitConfig,
  WINDOWS_CHECKOUT_GIT_CONFIG_ARGS,
  withWslWindowsCheckoutGitConfig,
  wslWindowsCheckoutKey,
  WSL_WINDOWS_CHECKOUT_TTL_MS
} from './wsl-windows-checkout-git-config'
import {
  ATTRIBUTE_PINNED_ROOT_SAMPLE,
  HOST_CONFIG_LOCAL_AUTOCRLF_FALSE,
  HOST_CONFIG_LOCAL_EOL_LF,
  HOST_CONFIG_SYSTEM_AUTOCRLF,
  LOCAL_AUTOCRLF_FALSE_CLONE_SAMPLE,
  NO_TOP_LEVEL_FILES_SAMPLE,
  PLAIN_WINDOWS_CLONE_SAMPLE,
  PRETTIER_ROOT_LF_SAMPLE,
  WSL_CLONE_WITH_CRLF_README_SAMPLE
} from './wsl-windows-checkout-line-endings.test-fixture'

afterEach(() => resetWslWindowsCheckoutGitConfigForTests())

const CWD = String.raw`C:\Users\dev\repo`
const KEY = wslWindowsCheckoutKey(CWD, 'Ubuntu')
const NOW = 1_000_000

describe('classifyLineEndingSample on captured checkouts', () => {
  it.each([
    ['a plain Windows clone', PLAIN_WINDOWS_CLONE_SAMPLE],
    ['a Windows clone whose root files a formatter re-saved as LF', PRETTIER_ROOT_LF_SAMPLE],
    ['a repo with no top-level text files', NO_TOP_LEVEL_FILES_SAMPLE],
    ['root files pinned LF by attributes over CRLF sources', ATTRIBUTE_PINNED_ROOT_SAMPLE]
  ])('detects %s', (_name, sample) => {
    expect(classifyLineEndingSample(sample, false)).toBe('windows')
  })

  it.each([
    ['a WSL clone after a Windows editor saved README as CRLF', WSL_CLONE_WITH_CRLF_README_SAMPLE],
    ['a Windows clone made with autocrlf=false', LOCAL_AUTOCRLF_FALSE_CLONE_SAMPLE]
  ])('does not flag %s', (_name, sample) => {
    expect(classifyLineEndingSample(sample, false)).toBe('not-windows')
  })

  it('treats clipped or over-cap output as inconclusive', () => {
    expect(classifyLineEndingSample(PLAIN_WINDOWS_CLONE_SAMPLE, true)).toBe('inconclusive')
    const overCap = Array.from(
      { length: LINE_ENDING_SAMPLE_LIMIT + 1 },
      (_, index) => `i/lf    w/crlf  attr/                 \tsrc/f${index}.ts`
    ).join('\n')
    expect(classifyLineEndingSample(overCap, false)).toBe('inconclusive')
  })

  it('needs a minimum amount of evidence', () => {
    const fewFiles = PLAIN_WINDOWS_CLONE_SAMPLE.split('\n').slice(0, 4).join('\n')
    expect(classifyLineEndingSample(fewFiles, false)).toBe('inconclusive')
    expect(classifyLineEndingSample('', false)).toBe('inconclusive')
  })
})

describe('parseHostAutocrlf', () => {
  it('reads the effective value with the last scope winning', () => {
    expect(parseHostAutocrlf(HOST_CONFIG_SYSTEM_AUTOCRLF)).toBe('true')
    expect(parseHostAutocrlf(HOST_CONFIG_LOCAL_AUTOCRLF_FALSE)).toBe('other')
    expect(parseHostAutocrlf('')).toBe('other')
  })

  it('ignores core.eol, which Windows Git overrides when autocrlf=true', () => {
    expect(parseHostAutocrlf(HOST_CONFIG_LOCAL_EOL_LF)).toBe('true')
  })

  it('accepts every Git boolean spelling and the bare key', () => {
    expect(parseHostAutocrlf('file:.git/config\tcore.autocrlf yes\n')).toBe('true')
    expect(parseHostAutocrlf('file:.git/config\tcore.autocrlf\n')).toBe('true')
    expect(parseHostAutocrlf('file:.git/config\tcore.autocrlf input\n')).toBe('other')
  })
})

describe('which commands run with Windows Git settings', () => {
  const read = ['-c', 'core.quotePath=false', 'status', '--porcelain=v2']
  const write = ['checkout', '--', 'README.md']

  it('flags nothing unless the host Git would write CRLF', () => {
    recordHostAutocrlf(KEY, 'other', NOW)
    recordLineEndingSample(KEY, 'windows', 'id', NOW)
    expect(usesWindowsCheckoutGitConfig(read, undefined, NOW)).toBe(false)
    expect(withWslWindowsCheckoutGitConfig(read, CWD, 'Ubuntu', 'win32', NOW)).toEqual(read)
  })

  it('flags reads as soon as the host answers, before the sample', () => {
    recordHostAutocrlf(KEY, 'true', NOW)
    expect(withWslWindowsCheckoutGitConfig(read, CWD, 'Ubuntu', 'win32', NOW)).toEqual([
      ...WINDOWS_CHECKOUT_GIT_CONFIG_ARGS,
      ...read
    ])
    expect(withWslWindowsCheckoutGitConfig(write, CWD, 'Ubuntu', 'win32', NOW)).toEqual([
      ...UNPROVEN_CHECKOUT_WRITE_GIT_CONFIG_ARGS,
      ...write
    ])
  })

  it('stops flagging reads once the sample proves an LF checkout', () => {
    recordHostAutocrlf(KEY, 'true', NOW)
    recordLineEndingSample(KEY, 'not-windows', 'id', NOW)
    expect(withWslWindowsCheckoutGitConfig(read, CWD, 'Ubuntu', 'win32', NOW)).toEqual(read)
  })

  it('flags writes only on a fresh Windows answer', () => {
    recordHostAutocrlf(KEY, 'true', NOW)
    recordLineEndingSample(KEY, 'windows', 'id', NOW)
    expect(withWslWindowsCheckoutGitConfig(write, CWD, 'Ubuntu', 'win32', NOW)[1]).toBe(
      'core.autocrlf=true'
    )
    const stale = NOW + WSL_WINDOWS_CHECKOUT_TTL_MS
    expect(withWslWindowsCheckoutGitConfig(write, CWD, 'Ubuntu', 'win32', stale)).toEqual([
      ...UNPROVEN_CHECKOUT_WRITE_GIT_CONFIG_ARGS,
      ...write
    ])
    expect(withWslWindowsCheckoutGitConfig(read, CWD, 'Ubuntu', 'win32', stale)[1]).toBe(
      'core.autocrlf=true'
    )
  })

  it('only normalizes staged content on an inconclusive sample, never writing CRLF', () => {
    recordHostAutocrlf(KEY, 'true', NOW)
    recordLineEndingSample(KEY, 'inconclusive', 'id', NOW)
    expect(withWslWindowsCheckoutGitConfig(write, CWD, 'Ubuntu', 'win32', NOW)).toEqual([
      '-c',
      'core.autocrlf=input',
      ...write
    ])
  })

  it('leaves writes unflagged once the sample proves an LF checkout', () => {
    recordHostAutocrlf(KEY, 'true', NOW)
    recordLineEndingSample(KEY, 'not-windows', 'id', NOW)
    expect(withWslWindowsCheckoutGitConfig(write, CWD, 'Ubuntu', 'win32', NOW)).toEqual(write)
  })

  it('never flags commands that create another checkout', () => {
    recordHostAutocrlf(KEY, 'true', NOW)
    recordLineEndingSample(KEY, 'windows', 'id', NOW)
    const worktreeAdd = ['-c', 'core.longpaths=true', 'worktree', 'add', '-b', 'x', '../x']
    expect(withWslWindowsCheckoutGitConfig(worktreeAdd, CWD, 'Ubuntu', 'win32', NOW)).toEqual(
      worktreeAdd
    )
    const clone = ['clone', 'https://example.com/r.git']
    expect(withWslWindowsCheckoutGitConfig(clone, CWD, 'Ubuntu', 'win32', NOW)).toEqual(clone)
  })

  it('keys case-insensitively and per distro, and ignores non-candidates', () => {
    recordHostAutocrlf(KEY, 'true', NOW)
    expect(
      withWslWindowsCheckoutGitConfig(read, 'c:/users/DEV/repo', 'ubuntu', 'win32', NOW)[1]
    ).toBe('core.autocrlf=true')
    expect(withWslWindowsCheckoutGitConfig(read, CWD, 'Debian', 'win32', NOW)).toEqual(read)
    expect(withWslWindowsCheckoutGitConfig(read, CWD, 'Ubuntu', 'linux', NOW)).toEqual(read)
    expect(withWslWindowsCheckoutGitConfig(read, CWD, undefined, 'win32', NOW)).toEqual(read)
  })
})

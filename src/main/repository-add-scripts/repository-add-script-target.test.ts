import { describe, expect, it } from 'vitest'
import type { ProjectExecutionRuntimeResolution } from '../../shared/project-execution-runtime'
import type { RepositoryAddScriptTarget } from '../../shared/repository-add-script-types'
import {
  copyRepositoryAddScriptTarget,
  isSameRepositoryAddScriptTarget,
  resolveRepositoryAddScriptTarget
} from './repository-add-script-target'

const windowsHost: ProjectExecutionRuntimeResolution = {
  status: 'resolved',
  runtime: {
    kind: 'windows-host',
    hostPlatform: 'win32',
    projectId: 'repo-1',
    reason: 'global-default',
    cacheKey: 'k'
  }
}
const localHost: ProjectExecutionRuntimeResolution = {
  status: 'resolved',
  runtime: {
    kind: 'local-host',
    hostPlatform: 'darwin',
    projectId: 'repo-1',
    reason: 'non-windows',
    cacheKey: 'k'
  }
}
function wsl(distro: string): ProjectExecutionRuntimeResolution {
  return {
    status: 'resolved',
    runtime: {
      kind: 'wsl',
      hostPlatform: 'wsl',
      projectId: 'repo-1',
      distro,
      reason: 'project-override',
      cacheKey: 'k'
    }
  }
}
const repair: ProjectExecutionRuntimeResolution = {
  status: 'repair-required',
  repair: {
    projectId: 'repo-1',
    preferredRuntime: { kind: 'wsl', distro: 'Ubuntu' },
    reason: 'wsl-distro-missing',
    source: 'project-override',
    cacheKey: 'k'
  }
}
const unc = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo'

describe('resolveRepositoryAddScriptTarget', () => {
  it('runs natively off Windows with no runtime or the local-host runtime', () => {
    expect(resolveRepositoryAddScriptTarget('/repo', undefined, 'linux')).toEqual({
      kind: 'native',
      cwd: '/repo'
    })
    expect(resolveRepositoryAddScriptTarget('/repo', localHost, 'darwin')).toEqual({
      kind: 'native',
      cwd: '/repo'
    })
  })

  it.each([
    ['a relative path', 'repo', undefined],
    ['an empty path', '', undefined],
    ['a NUL byte', '/re\0po', undefined],
    ['a WSL runtime', '/repo', wsl('Ubuntu')],
    ['a Windows runtime', '/repo', windowsHost],
    ['a repair-required runtime', '/repo', repair]
  ] as const)('refuses %s off Windows', (_name, path, runtime) => {
    expect(resolveRepositoryAddScriptTarget(path, runtime, 'linux')).toBeNull()
  })

  it('refuses an unresolved or local-host runtime on Windows instead of defaulting to native', () => {
    expect(resolveRepositoryAddScriptTarget('C:\\repo', undefined, 'win32')).toBeNull()
    expect(resolveRepositoryAddScriptTarget('C:\\repo', localHost, 'win32')).toBeNull()
    expect(resolveRepositoryAddScriptTarget('C:\\repo', repair, 'win32')).toBeNull()
  })

  it('runs natively for an explicit Windows host runtime', () => {
    expect(resolveRepositoryAddScriptTarget('C:\\repo', windowsHost, 'win32')).toEqual({
      kind: 'native',
      cwd: 'C:\\repo'
    })
    expect(resolveRepositoryAddScriptTarget('repo', windowsHost, 'win32')).toBeNull()
    expect(resolveRepositoryAddScriptTarget('C:\\re\0po', windowsHost, 'win32')).toBeNull()
    expect(resolveRepositoryAddScriptTarget('d:/My Repos/repo', windowsHost, 'win32')).toEqual({
      kind: 'native',
      cwd: 'd:/My Repos/repo'
    })
  })

  // cmd.exe cannot use a UNC cwd and silently falls back to the Windows directory.
  it.each([
    ['a root-relative path', '\\foo'],
    ['a forward-slash root path', '/foo'],
    ['a drive-relative path', 'C:foo'],
    ['a network share', '\\\\server\\share\\repo'],
    ['a verbatim device path', '\\\\?\\C:\\repo'],
    ['a device namespace path', '\\\\.\\x']
  ])('refuses %s as a native Windows cwd', (_name, path) => {
    expect(resolveRepositoryAddScriptTarget(path, windowsHost, 'win32')).toBeNull()
  })

  it('routes a Windows drive path through the requested WSL distro', () => {
    expect(resolveRepositoryAddScriptTarget('C:\\repo', wsl('Debian'), 'win32')).toEqual({
      kind: 'wsl',
      distro: 'Debian',
      cwd: '/mnt/c/repo'
    })
  })

  it.each([
    ['a blank distro', 'C:\\repo', wsl(' ')],
    ['a non-drive path', 'repo', wsl('Debian')],
    ['a non-WSL UNC share', '\\\\server\\share\\repo', wsl('Debian')]
  ] as const)('refuses a WSL runtime with %s', (_name, path, runtime) => {
    expect(resolveRepositoryAddScriptTarget(path, runtime, 'win32')).toBeNull()
  })

  it('accepts a WSL UNC path whose distro agrees with the runtime', () => {
    const expected = { kind: 'wsl', distro: 'Ubuntu', cwd: '/home/me/repo' }
    expect(resolveRepositoryAddScriptTarget(unc, wsl('Ubuntu'), 'win32')).toEqual(expected)
    expect(resolveRepositoryAddScriptTarget(unc, windowsHost, 'win32')).toEqual(expected)
  })

  it('refuses a WSL UNC path whose distro conflicts with the requested distro', () => {
    expect(resolveRepositoryAddScriptTarget(unc, wsl('Debian'), 'win32')).toBeNull()
  })

  it('never treats a UNC-looking path as WSL off Windows', () => {
    expect(resolveRepositoryAddScriptTarget('//wsl$/Ubuntu/repo', undefined, 'linux')).toEqual({
      kind: 'native',
      cwd: '//wsl$/Ubuntu/repo'
    })
  })

  it('returns a fresh object on every call', () => {
    const first = resolveRepositoryAddScriptTarget('/repo', undefined, 'linux')
    const second = resolveRepositoryAddScriptTarget('/repo', undefined, 'linux')
    expect(first).not.toBe(second)
  })
})

describe('target comparison and copying', () => {
  const native: RepositoryAddScriptTarget = { kind: 'native', cwd: '/repo' }
  const guest: RepositoryAddScriptTarget = { kind: 'wsl', distro: 'Ubuntu', cwd: '/repo' }

  it('compares every field', () => {
    expect(isSameRepositoryAddScriptTarget(native, { kind: 'native', cwd: '/repo' })).toBe(true)
    expect(isSameRepositoryAddScriptTarget(native, guest)).toBe(false)
    expect(isSameRepositoryAddScriptTarget(guest, { ...guest, distro: 'Debian' })).toBe(false)
    expect(isSameRepositoryAddScriptTarget(guest, { ...guest, cwd: '/other' })).toBe(false)
    expect(isSameRepositoryAddScriptTarget(null, native)).toBe(false)
  })

  it('copies only valid targets, dropping unknown fields', () => {
    const withExtra = { ...guest, extra: 'x' }
    const copy = copyRepositoryAddScriptTarget(withExtra)
    expect(copy).toEqual(guest)
    expect(copy).not.toBe(withExtra)
    expect(copyRepositoryAddScriptTarget({ kind: 'wsl', distro: '', cwd: '/r' })).toBeNull()
    expect(copyRepositoryAddScriptTarget({ kind: 'wsl', distro: 'U', cwd: 'r' })).toBeNull()
    expect(copyRepositoryAddScriptTarget({ kind: 'native', cwd: '' })).toBeNull()
    expect(copyRepositoryAddScriptTarget(null)).toBeNull()
  })
})

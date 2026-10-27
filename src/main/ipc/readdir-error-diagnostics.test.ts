import { describe, expect, it } from 'vitest'
import { buildReadDirErrorBreadcrumb, classifyReadDirPath } from './readdir-error-diagnostics'

describe('classifyReadDirPath', () => {
  it('classifies a WSL UNC path without leaking it', () => {
    const classification = classifyReadDirPath(
      '\\\\wsl.localhost\\Ubuntu\\home\\u\\repo',
      undefined
    )
    expect(classification).toEqual({ hasConnectionId: false, isUNC: true, isWsl: true })
  })

  it('classifies the legacy \\\\wsl$ root as WSL', () => {
    expect(classifyReadDirPath('\\\\wsl$\\Ubuntu\\home', undefined).isWsl).toBe(true)
  })

  it('classifies a plain network UNC share as UNC but not WSL', () => {
    const classification = classifyReadDirPath('\\\\fileserver\\share\\dir', undefined)
    expect(classification).toMatchObject({ isUNC: true, isWsl: false })
    expect(classification.driveLetter).toBeUndefined()
  })

  it('extracts an uppercased drive letter for mapped drives', () => {
    expect(classifyReadDirPath('z:\\projects\\repo', undefined)).toEqual({
      hasConnectionId: false,
      isUNC: false,
      isWsl: false,
      driveLetter: 'Z'
    })
  })

  it('flags the SSH connection without recording it', () => {
    const classification = classifyReadDirPath('/remote/repo', 'ssh-1')
    expect(classification).toEqual({ hasConnectionId: true, isUNC: false, isWsl: false })
  })

  it('never includes the raw path in the classification', () => {
    const classification = classifyReadDirPath('\\\\wsl.localhost\\Ubuntu\\secret\\path', 'ssh-9')
    expect(JSON.stringify(classification)).not.toContain('secret')
  })
})

describe('buildReadDirErrorBreadcrumb', () => {
  it('captures throw site, error code/name, and path classification', () => {
    const breadcrumb = buildReadDirErrorBreadcrumb({
      dirPath: '\\\\wsl.localhost\\Ubuntu\\home\\u\\repo',
      connectionId: undefined,
      throwSite: 'readdir',
      error: Object.assign(new Error('EIO: i/o error'), { code: 'EIO' })
    })
    expect(breadcrumb).toEqual({
      throwSite: 'readdir',
      errorName: 'Error',
      errorCode: 'EIO',
      hasConnectionId: false,
      isUNC: true,
      isWsl: true
    })
  })

  it('omits errorCode when the error has none', () => {
    const breadcrumb = buildReadDirErrorBreadcrumb({
      dirPath: '/remote/repo',
      connectionId: 'ssh-1',
      throwSite: 'ssh-provider',
      error: new Error('Remote connection dropped.')
    })
    expect(breadcrumb).toMatchObject({ throwSite: 'ssh-provider', errorName: 'Error' })
    expect(breadcrumb.errorCode).toBeUndefined()
    expect(breadcrumb.hasConnectionId).toBe(true)
  })
})

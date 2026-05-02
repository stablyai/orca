import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CONTAINER_WORKDIR,
  resolveDockerBindMount,
  translateWindowsPathForWsl2
} from './docker-mount'

describe('docker-mount', () => {
  it('keeps macOS paths unchanged', () => {
    expect(resolveDockerBindMount({ hostPath: '/Users/me/repo', platform: 'darwin' })).toEqual({
      source: '/Users/me/repo',
      target: DEFAULT_CONTAINER_WORKDIR,
      readonly: undefined
    })
  })

  it('keeps Linux paths unchanged', () => {
    expect(
      resolveDockerBindMount({ hostPath: '/home/me/repo', platform: 'linux', readonly: true })
    ).toEqual({
      source: '/home/me/repo',
      target: DEFAULT_CONTAINER_WORKDIR,
      readonly: true
    })
  })

  it('translates Windows drive paths for Docker Desktop WSL2', () => {
    expect(translateWindowsPathForWsl2('C:\\Users\\u\\repo')).toBe('/mnt/c/Users/u/repo')
    expect(
      resolveDockerBindMount({
        hostPath: 'D:\\code\\repo',
        platform: 'win32',
        containerPath: '/workspace'
      })
    ).toMatchObject({ source: '/mnt/d/code/repo', target: '/workspace' })
  })

  it('leaves non-drive Windows paths unchanged', () => {
    expect(translateWindowsPathForWsl2('\\\\wsl.localhost\\Ubuntu\\home\\u\\repo')).toBe(
      '\\\\wsl.localhost\\Ubuntu\\home\\u\\repo'
    )
  })
})

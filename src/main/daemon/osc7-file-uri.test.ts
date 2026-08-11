import { describe, expect, it } from 'vitest'
import { parseFileUriPath, parseFileUriPathParts } from './osc7-file-uri'

describe('parseFileUriPath', () => {
  it('accepts host-qualified POSIX file URI authorities as plain paths', () => {
    expect(parseFileUriPath('file://remote-host/tmp/result.json', { pathFlavor: 'posix' })).toBe(
      '/tmp/result.json'
    )
  })

  it('accepts empty and localhost POSIX file URI authorities', () => {
    expect(parseFileUriPath('file:///tmp/result.json')).toBe('/tmp/result.json')
    expect(parseFileUriPath('file://localhost/tmp/result.json')).toBe('/tmp/result.json')
  })

  it('keeps remote OSC7 authorities as POSIX paths for SSH PTYs on Windows', () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    try {
      expect(
        parseFileUriPathParts('file://remote-host/home/me/repo', {
          remotePosixAuthority: true
        })
      ).toEqual({ path: '/home/me/repo', hostname: 'remote-host' })
      expect(parseFileUriPathParts('file://server/share/repo')).toEqual({
        path: '\\\\server\\share\\repo',
        hostname: 'server'
      })
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform)
      }
    }
  })

  it('parses Windows SSH OSC7 drive paths independent of the desktop platform', () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    try {
      expect(parseFileUriPathParts('file:///C:/Users/me/repo', { pathFlavor: 'win32' })).toEqual({
        path: 'C:/Users/me/repo',
        hostname: ''
      })
      expect(
        parseFileUriPathParts('file://remote-host/C:/Users/me/repo', { pathFlavor: 'win32' })
      ).toEqual({
        path: 'C:/Users/me/repo',
        hostname: 'remote-host'
      })
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform)
      }
    }
  })

  it.each(['machine-name', 'localhost', ''])(
    'uses the resolved WSL distro for authority %s',
    (authority) => {
      const uri = authority ? `file://${authority}/home/me/my%20repo` : 'file:///home/me/my%20repo'
      expect(parseFileUriPathParts(uri, { pathFlavor: 'win32', wslDistro: 'Ubuntu' })).toEqual({
        path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\my repo',
        hostname: authority === 'localhost' ? '' : authority
      })
    }
  )

  it('maps lowercase drvfs paths and rejects malformed percent encoding in WSL context', () => {
    expect(parseFileUriPath('file://host/mnt/c/work', { wslDistro: 'Ubuntu' })).toBe('C:\\work')
    expect(parseFileUriPath('file://host/home/%ZZ', { wslDistro: 'Ubuntu' })).toBeNull()
  })
})

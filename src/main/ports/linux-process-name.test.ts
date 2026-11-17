import { describe, expect, it } from 'vitest'
import { linuxProcessName } from './local-workspace-platform-port-scanner'

describe('linuxProcessName', () => {
  it('keeps a real comm', () => {
    expect(linuxProcessName('python3', '/usr/bin/python3')).toBe('python3')
  })

  it('names Node servers by their executable instead of the main thread name', () => {
    expect(linuxProcessName('MainThread', '/opt/node/bin/node')).toBe('node')
  })

  it('falls back to comm when argv is unreadable', () => {
    expect(linuxProcessName('MainThread', undefined)).toBe('MainThread')
    expect(linuxProcessName(undefined, undefined)).toBeUndefined()
  })
})

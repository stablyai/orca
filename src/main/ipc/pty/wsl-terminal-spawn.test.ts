import { afterEach, describe, expect, it } from 'vitest'
import { isWslTerminalSpawn } from './wsl-terminal-spawn'

const platform = process.platform
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: platform })
})

describe('isWslTerminalSpawn', () => {
  it('is a WSL shell, or (on Windows) a folder under a WSL share', () => {
    expect(isWslTerminalSpawn('wsl.exe', 'C:\\repo')).toBe(true)
    Object.defineProperty(process, 'platform', { value: 'win32' })
    expect(isWslTerminalSpawn(undefined, '\\\\wsl.localhost\\Ubuntu\\home\\u')).toBe(true)
    expect(isWslTerminalSpawn(undefined, '\\\\wsl$\\Ubuntu\\home\\u')).toBe(true)
  })

  it('is not a native shell in a Windows folder, or a spawn with no folder', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    expect(isWslTerminalSpawn('powershell.exe', 'C:\\repo')).toBe(false)
    expect(isWslTerminalSpawn(undefined, null)).toBe(false)
    expect(isWslTerminalSpawn(undefined, undefined)).toBe(false)
  })
})

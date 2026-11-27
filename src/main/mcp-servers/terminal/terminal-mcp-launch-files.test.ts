import { describe, expect, it } from 'vitest'
import { wslGuestDrivePath } from './terminal-mcp-launch-files'

describe('a Windows path as a WSL guest opens it', () => {
  it('goes through the drive mount, lowercase letter, forward slashes, spaces kept', () => {
    expect(
      wslGuestDrivePath(
        null,
        'C:\\Users\\Ada B\\AppData\\Roaming\\orca\\wsl-managed-cli\\ab12\\orca-ide'
      )
    ).toBe('/mnt/c/Users/Ada B/AppData/Roaming/orca/wsl-managed-cli/ab12/orca-ide')
    expect(wslGuestDrivePath('Ubuntu', 'D:/data/claude-1.json')).toBe('/mnt/d/data/claude-1.json')
  })

  it('has no guest path for a path off every drive', () => {
    expect(wslGuestDrivePath(null, '\\\\server\\share\\x.json')).toBeNull()
    expect(wslGuestDrivePath(null, '/home/ada/x.json')).toBeNull()
  })
})

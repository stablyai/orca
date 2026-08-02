import { describe, expect, it, vi } from 'vitest'
import { detectLinuxInstallCommandFromOsRelease } from './fs-handler-install-rg'

describe('detectLinuxInstallCommandFromOsRelease', () => {
  it('uses apt for Debian and Ubuntu families', () => {
    expect(detectLinuxInstallCommandFromOsRelease('ID=ubuntu')).toBe('sudo apt install ripgrep')
    expect(detectLinuxInstallCommandFromOsRelease('ID=pop\nID_LIKE="ubuntu debian"')).toBe(
      'sudo apt install ripgrep'
    )
  })

  it('uses distro-specific commands for common non-Debian families', () => {
    expect(detectLinuxInstallCommandFromOsRelease('ID="fedora"')).toBe('sudo dnf install ripgrep')
    expect(detectLinuxInstallCommandFromOsRelease('ID=manjaro\r\nID_LIKE="arch"')).toBe(
      'sudo pacman -S ripgrep'
    )
    expect(detectLinuxInstallCommandFromOsRelease("ID=postmarketos\nID_LIKE='alpine'")).toBe(
      'sudo apk add ripgrep'
    )
  })

  it('falls back to generic Linux package-manager guidance', () => {
    expect(detectLinuxInstallCommandFromOsRelease('ID=unknown')).toBe(
      'install ripgrep via your package manager (e.g. apt/dnf/pacman)'
    )
  })

  it('does not use whitespace regex splitting for ID_LIKE parsing', () => {
    const splitSpy = vi.spyOn(String.prototype, 'split')

    expect(detectLinuxInstallCommandFromOsRelease('ID=unknown\nID_LIKE="rhel fedora"')).toBe(
      'sudo dnf install ripgrep'
    )

    const usedWhitespaceFieldSplit = splitSpy.mock.calls.some(
      ([separator]) => separator instanceof RegExp && separator.source.includes('\\s+')
    )
    splitSpy.mockRestore()
    expect(usedWhitespaceFieldSplit).toBe(false)
  })
})

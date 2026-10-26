import { describe, expect, it } from 'vitest'
import { computerProviderUnavailableMessage } from './computer-provider-unavailable-message'

describe('computerProviderUnavailableMessage', () => {
  it('gives macOS developers the helper build and restart step', () => {
    expect(computerProviderUnavailableMessage('darwin')).toContain(
      'run pnpm build:computer-macos and restart Orca from this worktree'
    )
    expect(computerProviderUnavailableMessage('darwin')).toContain(
      'Orca Computer Use.app was not found or this macOS version is unsupported'
    )
  })

  it('names the runtime file a Linux or Windows install is missing', () => {
    expect(computerProviderUnavailableMessage('linux')).toContain('computer-use-linux/runtime.py')
    expect(computerProviderUnavailableMessage('win32')).toContain(
      'computer-use-windows/runtime.ps1'
    )
  })

  it('keeps unsupported platforms explicit', () => {
    expect(computerProviderUnavailableMessage('freebsd')).toBe(
      'computer-use has no native provider for freebsd'
    )
  })
})

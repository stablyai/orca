import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  capability: vi.fn(),
  resolveInvocation: vi.fn()
}))

vi.mock('./interactive-capability', () => ({
  readZCodeInteractiveCapability: mocks.capability
}))

vi.mock('./zcode-cli-invocation', () => ({
  resolveZcodeCliInvocation: mocks.resolveInvocation
}))

import {
  assertZcodeTerminalLaunchAvailable,
  readZcodeTerminalLaunchAdmission
} from './terminal-launch-admission'

const standalone = {
  command: '/usr/local/bin/zcode',
  prefixArgs: [],
  envOverlay: {},
  identity: 'standalone',
  source: 'standalone' as const
}

const desktop = {
  command: '/opt/ZCode/zcode',
  prefixArgs: ['/opt/ZCode/resources/glm/zcode.cjs'],
  envOverlay: { ELECTRON_RUN_AS_NODE: '1' },
  identity: 'desktop',
  source: 'desktop-bundle' as const
}

beforeEach(() => {
  mocks.capability.mockReset()
  mocks.resolveInvocation.mockReset()
})

describe('ZCode terminal launch admission', () => {
  it('rejects Desktop without executing its Electron binary as a TUI probe', async () => {
    mocks.resolveInvocation.mockReturnValue(desktop)

    await expect(readZcodeTerminalLaunchAdmission()).resolves.toEqual({
      status: 'desktop-only',
      invocation: desktop
    })
    await expect(assertZcodeTerminalLaunchAvailable()).rejects.toThrow(
      'ZCode Desktop does not include the terminal TUI'
    )
    expect(mocks.capability).not.toHaveBeenCalled()
  })

  it('admits only a standalone command proven to provide the TUI', async () => {
    mocks.resolveInvocation.mockReturnValue(standalone)
    mocks.capability.mockResolvedValue('interactive')

    await expect(readZcodeTerminalLaunchAdmission()).resolves.toEqual({
      status: 'available',
      invocation: standalone
    })
    await expect(assertZcodeTerminalLaunchAvailable()).resolves.toBeUndefined()
  })

  it.each(['missing-tui', 'unknown'] as const)(
    'rejects a standalone command with %s capability',
    async (capability) => {
      mocks.resolveInvocation.mockReturnValue(standalone)
      mocks.capability.mockResolvedValue(capability)

      await expect(assertZcodeTerminalLaunchAvailable()).rejects.toThrow(
        'could not be verified as a terminal TUI'
      )
    }
  )
})

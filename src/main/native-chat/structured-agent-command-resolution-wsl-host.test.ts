import { describe, expect, it, vi } from 'vitest'
import type * as GuestDrivePath from '../ipc/wsl-guest-windows-drive-path'

const resolveGuestNativeProgram = vi.hoisted(() => vi.fn<() => string | null>())
vi.mock('../ipc/wsl-guest-windows-drive-path', async (importOriginal) => ({
  ...(await importOriginal<typeof GuestDrivePath>()),
  resolveGuestNativeProgram
}))

import {
  resolveAgainAfterRefreshOnMissingProgram,
  resolveStructuredAgentCommand
} from './structured-agent-command-resolution'

describe('a chat program on a WSL host with only a Windows copy', () => {
  it('rereads the shell once, so a WSL install made since the last read is found', async () => {
    resolveGuestNativeProgram.mockReturnValueOnce(null).mockReturnValueOnce('/home/me/bin/claude')
    const refresh = vi.fn(async () => {})
    await expect(
      resolveAgainAfterRefreshOnMissingProgram(
        async () => resolveStructuredAgentCommand('claude', {}),
        refresh,
        { env: () => ({}) }
      )
    ).resolves.toEqual({ command: '/home/me/bin/claude', prefixArgs: [] })
    expect(refresh).toHaveBeenCalledOnce()
  })
})

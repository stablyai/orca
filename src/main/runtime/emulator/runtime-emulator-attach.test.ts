import { describe, expect, it } from 'vitest'
import type { EmulatorBridge } from '../../emulator/emulator-bridge'
import type { EmulatorSessionInfo } from '../../emulator/emulator-types'
import type { RuntimeEmulatorCommandHost } from './runtime-emulator-commands'
import { RuntimeEmulatorAttach } from './runtime-emulator-attach'

const agentAndroid: EmulatorSessionInfo = {
  deviceUdid: 'emulator-5554',
  streamUrl: 'scrcpy://emulator-5554',
  wsUrl: '',
  backend: 'android'
}

/** A workspace whose agent attached an Android emulator, whose stream may have exited since;
 *  `late`: the agent attaches only while the desktop's attach is listing devices. */
function agentWorkspace(reusable: boolean, late = false) {
  const stopped: string[] = []
  let agentAttached = !late
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a fake of only the bridge calls attach makes on these paths.
  const bridge = {
    getActiveForWorktree: () => (agentAttached ? agentAndroid : null),
    getReusableActiveForWorktree: async () => (reusable && agentAttached ? agentAndroid : null),
    listAllDevices: async () => {
      agentAttached = true
      return [
        { id: 'IOS-1', name: 'iPhone', backend: 'ios', state: 'booted', isAvailable: true },
        {
          id: 'emulator-5554',
          name: 'Pixel',
          backend: 'android',
          state: 'booted',
          isAvailable: true
        }
      ]
    },
    stopActiveForSwitch: async (worktreeId: string) => void stopped.push(worktreeId),
    acquireHelperForDevice: async () => {
      throw new Error('no device should start')
    }
  } as unknown as EmulatorBridge
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a fake of only the host calls attach makes.
  const host = {
    getSettings: () => ({}),
    resolveEmulatorWorkspaceId: async (selector: string) => selector
  } as unknown as RuntimeEmulatorCommandHost
  const attach = new RuntimeEmulatorAttach(
    host,
    () => bridge,
    () => {}
  )
  return { attach, stopped }
}

describe('a backend-limited emulator attach', () => {
  it.each([true, false])(
    "never switches away another backend's session (stream live: %s)",
    async (reusable) => {
      const { attach, stopped } = agentWorkspace(reusable)

      await expect(
        attach.attach({ worktree: 'wt', backend: 'ios', userInitiated: true })
      ).rejects.toMatchObject({ code: 'emulator_backend_unsupported' })
      await expect(
        attach.attach({ worktree: 'wt', backend: 'ios', device: 'emulator-5554' })
      ).rejects.toMatchObject({ code: 'emulator_backend_unsupported' })
      expect(stopped).toEqual([])
    }
  )

  it("never switches away another backend's session that attached while it was choosing", async () => {
    const { attach, stopped } = agentWorkspace(false, true)

    await expect(attach.attach({ worktree: 'wt', backend: 'ios' })).rejects.toMatchObject({
      code: 'emulator_backend_unsupported'
    })
    expect(stopped).toEqual([])
  })
})

import type { EmulatorBridge } from './emulator-bridge'
import { assertSimulatorInputNotShadowedByDeviceHub } from './simulator-device-hub-input'

// Device Hub only shadows simulator HID; Android sessions and no session have nothing to check.
export async function assertWorktreeInputNotShadowedByDeviceHub(
  bridge: Pick<EmulatorBridge, 'getActiveForWorktree'>,
  worktreeId: string | undefined
): Promise<void> {
  const session = bridge.getActiveForWorktree(worktreeId)
  if (session?.backend === 'ios') {
    await assertSimulatorInputNotShadowedByDeviceHub(session.deviceUdid)
  }
}

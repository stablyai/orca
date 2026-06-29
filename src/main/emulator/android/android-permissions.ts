import { EmulatorError } from '../emulator-errors'

// Pure arg-building for `adb shell pm` permission ops. No process execution
// here: the caller prepends the resolved adb binary path to every arg array.

export type AndroidPermissionOp = 'grant' | 'revoke' | 'reset'

// grant/revoke: `adb -s <serial> shell pm <op> <package> <permission>`
// reset:        `adb -s <serial> shell pm reset-permissions <package>`
// `reset` clears every runtime grant, so the permission argument is ignored.
export function permissionArgs(
  serial: string,
  op: AndroidPermissionOp,
  packageName: string,
  permission?: string
): string[] {
  const base = ['-s', serial, 'shell', 'pm']
  // `pm reset-permissions` resets every app's runtime grants and rejects a
  // package argument, so it is omitted here.
  if (op === 'reset') {
    return [...base, 'reset-permissions']
  }
  // grant/revoke target a single permission, so it must be present.
  if (!permission || permission.trim() === '') {
    throw new EmulatorError('emulator_error', `pm ${op} requires a permission name`)
  }
  return [...base, op, packageName, permission]
}

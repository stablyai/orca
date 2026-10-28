import { EmulatorError } from '../emulator-errors'

export type AndroidPermissionOp = 'grant' | 'revoke' | 'reset'

export function permissionArgs(
  serial: string,
  op: AndroidPermissionOp,
  packageName: string,
  permission?: string
): string[] {
  const base = ['-s', serial, 'shell', 'pm']
  // reset-permissions is global and rejects a package argument.
  if (op === 'reset') {
    return [...base, 'reset-permissions']
  }
  if (!permission || permission.trim() === '') {
    throw new EmulatorError('emulator_error', `pm ${op} requires a permission name`)
  }
  return [...base, op, packageName, permission]
}

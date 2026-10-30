import { getOptionalStringFlag, getRequiredStringFlag } from './flags'
import { RuntimeClientError } from './runtime-client'

export type EmulatorPermissionRequest = {
  op: 'grant' | 'revoke' | 'reset'
  packageName?: string
  permission?: string
}

export function parseEmulatorPermissionRequest(
  flags: Map<string, string | boolean>
): EmulatorPermissionRequest {
  const op = getRequiredStringFlag(flags, 'op')
  if (op !== 'grant' && op !== 'revoke' && op !== 'reset') {
    throw new RuntimeClientError('invalid_argument', '<op> must be grant, revoke, or reset')
  }
  const packageName = getOptionalStringFlag(flags, 'package')
  const permission = getOptionalStringFlag(flags, 'permission')
  if (op === 'reset') {
    if (packageName || permission) {
      throw new RuntimeClientError(
        'invalid_argument',
        'reset does not accept package or permission'
      )
    }
    return { op }
  }
  if (!permission) {
    throw new RuntimeClientError('invalid_argument', `<permission> is required for ${op}`)
  }
  return { op, packageName: packageName ?? getRequiredStringFlag(flags, 'package'), permission }
}

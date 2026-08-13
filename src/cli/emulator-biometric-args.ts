import { getOptionalStringFlag, getRequiredStringFlag } from './flags'
import { RuntimeClientError } from './runtime-client'

export type EmulatorBiometricRequest = {
  action: 'enroll' | 'unenroll' | 'match' | 'nomatch'
  type?: 'face' | 'touch'
}

export function parseEmulatorBiometricRequest(
  flags: Map<string, string | boolean>
): EmulatorBiometricRequest {
  const action = getRequiredStringFlag(flags, 'action')
  if (action !== 'enroll' && action !== 'unenroll' && action !== 'match' && action !== 'nomatch') {
    throw new RuntimeClientError(
      'invalid_argument',
      '<action> must be enroll, unenroll, match, or nomatch'
    )
  }
  const type = getOptionalStringFlag(flags, 'type')
  if (action === 'enroll' || action === 'unenroll') {
    // Why: enrollment is one biometry-agnostic switch, so accepting --type here would
    // imply the caller had enrolled Touch ID specifically.
    if (type) {
      throw new RuntimeClientError(
        'invalid_argument',
        `--type is not accepted for ${action} — enrollment covers whichever biometry the device has`
      )
    }
    return { action }
  }
  if (type !== undefined && type !== 'face' && type !== 'touch') {
    throw new RuntimeClientError('invalid_argument', '--type must be face or touch')
  }
  return type === undefined ? { action } : { action, type }
}

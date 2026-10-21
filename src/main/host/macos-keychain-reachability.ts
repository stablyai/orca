import { runProcess } from '@orca/process-host'

export type KeychainReachability =
  | { kind: 'reachable' }
  | { kind: 'unavailable'; reason: 'no_default_keychain' | 'interaction_not_allowed' | 'timeout' }
  /** The probe could not tell; callers keep today's behavior. */
  | { kind: 'unknown' }

const PROBE_TIMEOUT_MS = 5_000

/**
 * Ask the macOS keychain, out of process, whether this login has a usable default keychain.
 *
 * Why out of process: the in-process question is `safeStorage`, which is synchronous and
 * can wait forever on an authorization prompt that a session without a GUI cannot show
 * (#25453). A child can be killed on a timeout.
 *
 * Why `show-keychain-info`: it reads settings of the default keychain and never reads a
 * secret, so it cannot raise the access prompt it is meant to detect.
 */
export async function probeMacosKeychainReachability(
  run: typeof runProcess = runProcess
): Promise<KeychainReachability> {
  let result: Awaited<ReturnType<typeof runProcess>>
  try {
    result = await run({
      program: '/usr/bin/security',
      args: ['show-keychain-info'],
      timeoutMs: PROBE_TIMEOUT_MS,
      maxOutputBytes: 16 * 1024,
      killOnOutputLimit: true
    })
  } catch {
    return { kind: 'unknown' }
  }
  if (result.timedOut) {
    return { kind: 'unavailable', reason: 'timeout' }
  }
  if (result.code === 0) {
    return { kind: 'reachable' }
  }
  // Why exit codes too: security(1) exits with the OSStatus low byte, so a localized message
  // still classifies (errSecNoDefaultKeychain -25307 = 37, errSecInteractionNotAllowed -25308 = 36).
  const output = `${result.stderr}\n${result.stdout}`
  if (result.code === 37 || /default keychain could not be found/i.test(output)) {
    return { kind: 'unavailable', reason: 'no_default_keychain' }
  }
  if (result.code === 36 || /interaction is not allowed/i.test(output)) {
    return { kind: 'unavailable', reason: 'interaction_not_allowed' }
  }
  return { kind: 'unknown' }
}

export function describeKeychainUnavailable(
  reason: Extract<KeychainReachability, { kind: 'unavailable' }>['reason']
): string {
  switch (reason) {
    case 'no_default_keychain':
      return 'this login has no default macOS keychain'
    case 'interaction_not_allowed':
      return 'the macOS keychain needs a prompt that this session cannot show'
    case 'timeout':
      return 'the macOS keychain did not answer within 5 seconds'
  }
}

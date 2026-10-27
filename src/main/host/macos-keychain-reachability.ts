import { runProcess } from '@orca/process-host'

export type KeychainReachability =
  | { kind: 'reachable' }
  | { kind: 'unavailable'; reason: 'no_default_keychain' | 'interaction_not_allowed' | 'timeout' }
  /** Inconclusive: preserve existing behavior. */
  | { kind: 'unknown' }

const PROBE_TIMEOUT_MS = 5_000

/** Probe settings out of process so a blocked keychain can time out without accessing secrets or freezing safeStorage (#25453). */
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
  // security(1) returns OSStatus low bytes even when its message is localized.
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

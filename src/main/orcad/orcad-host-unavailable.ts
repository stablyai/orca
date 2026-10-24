// Remember repeatable deployment refusals per app version; host-fixable settings must be reprobed.

export class OrcadHostUnsupportedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OrcadHostUnsupportedError'
  }
}

export class OrcadArtifactsUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OrcadArtifactsUnavailableError'
  }
}

export class OrcadStdioBridgeUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OrcadStdioBridgeUnavailableError'
  }
}

export const ORCAD_TUNNEL_UNAVAILABLE_REASON = 'ssh_tunnel_unavailable'
export const ORCAD_WINDOWS_LAUNCH_REFUSED_CODE = 'orcad_windows_launch_refused'
export const ORCAD_WINDOWS_COMMAND_LINE_UNSAFE_CODE = 'orcad_windows_command_line_unsafe'

export type OrcadHostUnavailableReason =
  | 'unsupported_host'
  | 'artifacts_unavailable'
  | 'libc_unidentified'
  | 'runtime_self_test'
  | 'runtime_noexec'
  | 'security_software'
  | 'native_preflight'
  | typeof ORCAD_TUNNEL_UNAVAILABLE_REASON

const UNAVAILABLE_BY_ERROR_NAME: Record<string, OrcadHostUnavailableReason> = {
  OrcadHostUnsupportedError: 'unsupported_host',
  OrcadArtifactsUnavailableError: 'artifacts_unavailable',
  OrcadRemoteLaunchUnsupportedError: 'unsupported_host',
  UnidentifiedHostLibcError: 'libc_unidentified',
  RemoteNodeRuntimeSelfTestError: 'runtime_self_test',
  RemoteNodeRuntimeNoexecError: 'runtime_noexec',
  RemoteNodeRuntimeSecurityModifiedError: 'security_software',
  OrcadStdioBridgeUnavailableError: ORCAD_TUNNEL_UNAVAILABLE_REASON,
  OrcadWindowsLaunchRefusedError: 'unsupported_host',
  OrcadWindowsCommandLineError: 'unsupported_host'
}

// Native preflight, PTY self-test and permanent Windows refusals repeat; transient races do not.
const UNAVAILABLE_BY_DEFERRAL_CODE: Record<string, OrcadHostUnavailableReason> = {
  orcad_candidate_preflight_failed: 'native_preflight',
  orcad_activation_pty_self_test_failed: 'native_preflight',
  [ORCAD_WINDOWS_LAUNCH_REFUSED_CODE]: 'unsupported_host',
  [ORCAD_WINDOWS_COMMAND_LINE_UNSAFE_CODE]: 'unsupported_host'
}

export function isOrcadHostUnavailableFixableOnHost(reason: string): boolean {
  return reason === 'runtime_noexec'
}

export function orcadCandidateLaunchFailureCode(error: unknown): string {
  const code = error instanceof Error && 'code' in error ? error.code : undefined
  return code === ORCAD_WINDOWS_LAUNCH_REFUSED_CODE ||
    code === ORCAD_WINDOWS_COMMAND_LINE_UNSAFE_CODE
    ? code
    : 'orcad_candidate_launch_failed'
}

export function classifyOrcadHostUnavailable(failure: unknown): OrcadHostUnavailableReason | null {
  if (failure instanceof Error) {
    return UNAVAILABLE_BY_ERROR_NAME[failure.name] ?? null
  }
  if (failure && typeof failure === 'object' && 'code' in failure) {
    const code = failure.code
    return typeof code === 'string' ? (UNAVAILABLE_BY_DEFERRAL_CODE[code] ?? null) : null
  }
  return null
}

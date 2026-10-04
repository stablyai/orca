import { homedir } from 'node:os'
import { isReasonixRemoteConfigHome, reasonixConfigRoots } from '../../shared/reasonix-config-roots'
import { resolveLoginShellEnvironment } from '../startup/login-shell-environment'

export async function resolveReasonixExecutionHostRoots(
  signal?: AbortSignal
): Promise<{ configHome: string; stateHome: string }> {
  signal?.throwIfAborted()
  const environment = await resolveLoginShellEnvironment()
  signal?.throwIfAborted()
  const roots = reasonixConfigRoots(homedir(), process.platform, environment)
  if (
    process.platform !== 'win32' &&
    (!isReasonixRemoteConfigHome(roots.configHome) || !isReasonixRemoteConfigHome(roots.stateHome))
  ) {
    throw new Error('Invalid Reasonix execution-host configuration root')
  }
  return roots
}

export async function resolveReasonixExecutionHostConfig(signal?: AbortSignal): Promise<string> {
  return (await resolveReasonixExecutionHostRoots(signal)).configHome
}

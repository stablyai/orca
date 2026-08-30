import { codexAuthMatchesSystemDefaultIdentity } from './codex-auth-identity'
import type { StoredCodexAuthObservation } from './managed-codex-auth-readiness'

export type WslRuntimeAuthProjection =
  | { action: 'replace' }
  | { action: 'keep'; deselect: boolean }
  | { action: 'wipe' }

export function decideWslRuntimeAuthProjection(args: {
  runtimeAuth: StoredCodexAuthObservation
  sourceAuth: StoredCodexAuthObservation
  explicitAccountSwitch: boolean
}): WslRuntimeAuthProjection {
  if (isIndeterminate(args.runtimeAuth) || isIndeterminate(args.sourceAuth)) {
    return { action: 'keep', deselect: false }
  }
  if (args.explicitAccountSwitch && args.sourceAuth.state === 'present') {
    return { action: 'replace' }
  }
  if (args.runtimeAuth.state === 'missing' || args.runtimeAuth.state === 'no-credential') {
    return args.sourceAuth.state === 'present' ? { action: 'replace' } : { action: 'wipe' }
  }
  if (args.sourceAuth.state !== 'present') {
    return { action: 'keep', deselect: false }
  }
  if (wslRuntimeAuthMayReplaceSource(args.runtimeAuth, args.sourceAuth)) {
    return { action: 'replace' }
  }
  return { action: 'keep', deselect: true }
}

// Why: a live credential with a conflicting or unprovable owner is not a stale mirror.
export function wslRuntimeAuthMayReplaceSource(
  runtimeAuth: StoredCodexAuthObservation,
  sourceAuth: StoredCodexAuthObservation
): boolean {
  if (
    runtimeAuth.state !== 'present' ||
    sourceAuth.state !== 'present' ||
    !runtimeAuth.contents ||
    !sourceAuth.contents
  ) {
    return false
  }
  if (runtimeAuth.contents === sourceAuth.contents) {
    return true
  }
  if (runtimeAuth.mode !== sourceAuth.mode) {
    return false
  }
  if (runtimeAuth.mode === 'chatgpt' || runtimeAuth.mode === 'chatgptAuthTokens') {
    return codexAuthMatchesSystemDefaultIdentity(runtimeAuth.contents, sourceAuth.contents)
  }
  return runtimeAuth.mode !== 'personalAccessToken'
}

function isIndeterminate(observation: StoredCodexAuthObservation): boolean {
  return observation.state === 'unreadable' || observation.state === 'incomplete'
}

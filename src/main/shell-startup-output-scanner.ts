import {
  createShellReadyScanState,
  drainShellReadyHeldBytes,
  scanForShellReadyBoundary,
  type ShellReadyScanState
} from './shell-ready-marker-scanner'
import {
  createShellStartupIdentityScanState,
  drainShellStartupIdentityHeldBytes,
  scanForShellStartupIdentity,
  type ShellStartupIdentityScanState
} from './shell-startup-identity-scanner'

export type ShellStartupOutputScanState = {
  ready: ShellReadyScanState
  identity: ShellStartupIdentityScanState | null
}

export type ShellStartupOutputScanResult = {
  output: string
  shellPid: number | null
  ready: boolean
  postMarkerBytesObserved: boolean
}

export function createShellStartupOutputScanState(): ShellStartupOutputScanState {
  return {
    ready: createShellReadyScanState(),
    identity: createShellStartupIdentityScanState()
  }
}

export function scanShellStartupOutput(
  state: ShellStartupOutputScanState,
  data: string
): ShellStartupOutputScanResult {
  const readiness = scanForShellReadyBoundary(state.ready, data)
  const postMarkerOutputIndex = readiness.postMarkerOutputIndex ?? readiness.output.length
  const identityInput = readiness.output.slice(0, postMarkerOutputIndex)
  let shellPid: number | null = null
  let output = identityInput
  if (state.identity) {
    const identity = scanForShellStartupIdentity(state.identity, identityInput)
    output = identity.output
    shellPid = identity.shellPid
    if (shellPid) {
      state.identity = null
    }
  }

  if (readiness.matched && state.identity) {
    output += drainShellStartupIdentityHeldBytes(state.identity)
    state.identity = null
  }
  output += readiness.output.slice(postMarkerOutputIndex)
  return {
    output,
    shellPid,
    ready: readiness.matched,
    postMarkerBytesObserved: readiness.postMarkerBytesObserved
  }
}

export function drainShellStartupOutputScanState(state: ShellStartupOutputScanState): string {
  const output = state.identity ? drainShellStartupIdentityHeldBytes(state.identity) : ''
  state.identity = null
  return output + drainShellReadyHeldBytes(state.ready)
}

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
  nativeSetupShell?: 'posix' | 'fish'
}

export function createShellStartupOutputScanState(): ShellStartupOutputScanState {
  return {
    ready: createShellReadyScanState(),
    identity: createShellStartupIdentityScanState()
  }
}

export function scanShellStartupOutput(
  state: ShellStartupOutputScanState,
  data: string,
  emit?: (data: string, removed?: boolean) => void
): ShellStartupOutputScanResult {
  let shellPid: number | null = null
  let output = ''
  const readiness = scanForShellReadyBoundary(state.ready, data, (part, removed) => {
    if (removed) {
      if (state.identity) {
        const held = drainShellStartupIdentityHeldBytes(state.identity)
        output += held
        emit?.(held)
        state.identity = null
      }
      emit?.('', true)
    } else if (state.identity) {
      const identity = scanForShellStartupIdentity(state.identity, part, (text, boundary) => {
        output += text
        emit?.(text, boundary)
      })
      if (identity.shellPid) {
        shellPid = identity.shellPid
        state.identity = null
      }
    } else {
      output += part
      emit?.(part)
    }
  })
  return {
    output,
    shellPid,
    ready: readiness.matched,
    ...(readiness.nativeSetupShell ? { nativeSetupShell: readiness.nativeSetupShell } : {}),
    postMarkerBytesObserved: readiness.postMarkerBytesObserved
  }
}

export function drainShellStartupOutputScanState(state: ShellStartupOutputScanState): string {
  const output = state.identity ? drainShellStartupIdentityHeldBytes(state.identity) : ''
  state.identity = null
  return output + drainShellReadyHeldBytes(state.ready)
}

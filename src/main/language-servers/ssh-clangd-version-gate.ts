// SSH clangd version gate (spec D7): probe the remote clangd over the relay's
// existing `agent.execNonInteractive` one-shot lane (which exists on every
// relay, unlike the new `lsp.*` family — so the version probe works against an
// old relay too). The long-lived clangd itself is spawned later via `lsp.spawn`
// (ticket 17); the version gate is a separate one-shot capture, never a
// long-lived process, so the capture prohibition (spec D8) does not apply.
//
// Disconnect: a missing/unreachable relay yields `unverifiable` (transport
// loss is never evidence of an absent clangd). The host re-probes on reconnect.
import { getSshLspRelay } from '../ssh/ssh-lsp-relay-registry'
import {
  parseClangdVersion,
  classifyClangdVersion,
  CLANGD_INSTALL_HINT,
  type ClangdVersionGateResult
} from './clangd-launch'

const CLANGD_VERSION_PROBE_TIMEOUT_MS = 10_000
const PROBE_MAX_OUTPUT_BYTES = 64 * 1024

/**
 * Probe + classify the remote clangd version. Runs `clangd --version` via the
 * relay's `agent.execNonInteractive`. Never rejects — a missing relay or a
 * missing binary resolves to a `reject` (with the install hint) so the host
 * surfaces the reason instead of hanging on every navigation request.
 */
export async function resolveSshClangdVersionGate(
  targetId: string
): Promise<ClangdVersionGateResult> {
  const mux = getSshLspRelay(targetId)
  if (!mux || mux.isDisposed()) {
    // Transport loss is `unverifiable` — surface as a reject with the reconnect
    // hint so the user knows to reconnect, not reinstall clangd.
    return {
      kind: 'reject',
      major: null,
      message: 'SSH relay is not connected. Reconnect the SSH target to enable C/C++ navigation.'
    }
  }
  try {
    const result = (await mux.request(
      'agent.execNonInteractive',
      {
        binary: 'clangd',
        args: ['--version'],
        cwd: '.',
        stdin: null,
        timeoutMs: CLANGD_VERSION_PROBE_TIMEOUT_MS
      },
      { timeoutMs: CLANGD_VERSION_PROBE_TIMEOUT_MS + 5_000 }
    )) as { stdout?: string; exitCode?: number | null; timedOut?: boolean } | null
    if (!result || result.timedOut) {
      return { kind: 'reject', major: null, message: CLANGD_INSTALL_HINT }
    }
    const major = parseClangdVersion(result.stdout ?? '')
    const kind = classifyClangdVersion(major)
    return { kind, major, message: messageForGate(kind, major) }
  } catch {
    // A method_not_found here would be an extremely old relay (pre agent.exec);
    // treat as unavailable with the install hint.
    return { kind: 'reject', major: null, message: CLANGD_INSTALL_HINT }
  }
}

function messageForGate(
  kind: 'ok' | 'suggest-upgrade' | 'reject',
  major: number | null
): string | null {
  if (kind === 'ok') {
    return null
  }
  if (kind === 'suggest-upgrade') {
    return `clangd ${major} works but navigation is best on clangd 16+; consider upgrading clangd on the SSH host.`
  }
  return major === null
    ? CLANGD_INSTALL_HINT
    : `clangd ${major} is below the supported floor of 12. ${CLANGD_INSTALL_HINT}`
}

void PROBE_MAX_OUTPUT_BYTES

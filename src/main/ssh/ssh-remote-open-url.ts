import { BrowserError } from '../browser/browser-error'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { ParsedRemoteCli } from './ssh-remote-cli-argument-error'
import type { RemoteOrcaCliRequest, RemoteOrcaCliResult } from './ssh-remote-cli-host-passthrough'

type DesktopOpener = Pick<OrcaRuntimeService, 'requestDesktopOpenUrlForSshTarget'>

/**
 * `orca open-url` from an SSH host: ask the desktop that owns this SSH connection to open the URL.
 * Why handled here: the calling host is identified only by the relay session's target id (set on
 * the desktop side), never by a `--worktree` the host supplies, so a compromised host cannot make
 * the approval prompt name another machine.
 */
export function runRemoteOpenUrl(
  runtime: DesktopOpener,
  request: RemoteOrcaCliRequest,
  parsed: ParsedRemoteCli
): RemoteOrcaCliResult {
  const url = parsed.flags.get('url')
  const sshTargetId =
    request.runtimeAuthority?.kind === 'ssh' ? request.runtimeAuthority.targetId : null
  if (typeof url !== 'string' || url.length === 0) {
    return { stdout: '', stderr: 'orca open-url: --url is required\n', exitCode: 2 }
  }
  // Not in scope: SSH sessions owned by a paired Orca server have no desktop attachment here,
  // so the xdg-open shim falls back to printing the link.
  if (!sshTargetId) {
    return {
      stdout: '',
      stderr: 'orca open-url: this SSH session has no desktop attachment\n',
      exitCode: 1
    }
  }
  let outcome: ReturnType<DesktopOpener['requestDesktopOpenUrlForSshTarget']>
  try {
    outcome = runtime.requestDesktopOpenUrlForSshTarget({ url, sshTargetId })
  } catch (error) {
    if (error instanceof BrowserError && error.code === 'invalid_argument') {
      return { stdout: '', stderr: 'orca open-url: only http(s) URLs can be opened\n', exitCode: 2 }
    }
    // Why surface it: reporting every failure as a bad URL hid real faults from the user.
    const message = error instanceof Error ? error.message : String(error)
    return { stdout: '', stderr: `orca open-url: ${message}\n`, exitCode: 1 }
  }
  if (outcome === 'sent') {
    return { stdout: `Sent to Orca on your desktop to approve: ${url}\n`, stderr: '', exitCode: 0 }
  }
  if (outcome === 'rate_limited') {
    return {
      stdout: '',
      stderr: 'orca open-url: too many requests; try again shortly\n',
      exitCode: 1
    }
  }
  return {
    stdout: '',
    stderr: 'orca open-url: no Orca desktop is attached to approve this\n',
    exitCode: 1
  }
}

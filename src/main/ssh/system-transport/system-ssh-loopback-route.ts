/** On Windows, hold a proxied ssh -N -L once; route later execs through loopback to avoid repeated proxy handshakes without ControlMaster. */
import type { ChildProcessHandle as ChildProcess } from '@orca/process-host/process-spec'
import {
  childProcessHasExited,
  signalProcessTree
} from '@orca/process-host/process-tree-termination'
import { createSshOperationAbortError } from '../connection/ssh-exec-options'
import type { SshTarget } from '../../../shared/ssh-types'
import type { SshResolvedConfig } from '../config/ssh-g-config-resolution'
import { admitSystemSshLoopbackRoute } from './system-ssh-loopback-route-admission'
import {
  isOpenSshConfigBackedTarget,
  type SystemSshBuildArgsOptions,
  type SystemSshLoopbackRouteArgs
} from './system-ssh-args'
import { spawnSystemSshCommand } from './system-ssh-command'
import {
  startSystemSshPortForwardProcess,
  waitForSystemSshForwardStartup
} from './system-ssh-forward-process'

// Allow the full proxy handshake: avoiding repeats is the route's purpose.
export const SYSTEM_SSH_LOOPBACK_ROUTE_LISTEN_TIMEOUT_MS = 60_000
export const SYSTEM_SSH_LOOPBACK_ROUTE_PROBE_TIMEOUT_MS = 15_000
const LOOPBACK_ROUTE_PROBE_MARKER = 'ORCA-SYSTEM-SSH-LOOPBACK-OK'

export type SystemSshLoopbackRoute = {
  args: SystemSshLoopbackRouteArgs
  onExit: (callback: () => void) => void
  dispose: () => void
}

export function shouldUseSystemSshLoopbackRoute(
  target: SshTarget,
  resolved: SshResolvedConfig | null,
  options: SystemSshBuildArgsOptions,
  platform: NodeJS.Platform = process.platform
): boolean {
  // Why opt-in: ssh_config can key settings on the real host name, which the route rewrites.
  if (
    platform !== 'win32' ||
    target.systemSshProxyConnectionReuse !== true ||
    target.systemSshConnectionReuse === false
  ) {
    return false
  }
  // Why: Kerberos derives the service principal from the dialled host name, which becomes 127.0.0.1.
  if (options.gssapiOnly || target.gssapiAuthentication || resolved?.gssapiAuthentication) {
    return false
  }
  // Why: an unclaimed alias already rewrites HostName/Port to the stored endpoint.
  if (options.aliasClaimedByConfig === false && isOpenSshConfigBackedTarget(target)) {
    return false
  }
  const configResolved = configBackedResolution(target, resolved)
  return configResolved
    ? Boolean(configResolved.proxyCommand || configResolved.proxyJump)
    : Boolean(target.proxyCommand || target.jumpHost)
}

// Why: Orca dials manual targets by their stored endpoint; `ssh -G` ran on the label, not that host.
function configBackedResolution(
  target: SshTarget,
  resolved: SshResolvedConfig | null
): SshResolvedConfig | null {
  return resolved && isOpenSshConfigBackedTarget(target) ? resolved : null
}

export async function startSystemSshLoopbackRoute(
  target: SshTarget,
  options: SystemSshBuildArgsOptions,
  platform: NodeJS.Platform = process.platform,
  signal?: AbortSignal
): Promise<SystemSshLoopbackRoute> {
  signal?.throwIfAborted()
  const admission = await admitSystemSshLoopbackRoute(target, options)
  if (!admission.admitted) {
    throw new Error(`System SSH loopback route skipped: ${admission.reason}`)
  }
  const { sshdPort, hostKeyAlias } = admission
  signal?.throwIfAborted()
  const forward = await startSystemSshPortForwardProcess(
    target,
    0,
    'localhost',
    sshdPort,
    // Why nonInteractive: this optional background login must fail silently, never ask for credentials.
    { ...options, keepAlive: true, nonInteractive: true },
    signal
  )
  let disposed = false
  const dispose = (): void => {
    if (disposed) {
      return
    }
    disposed = true
    stopLoopbackForward(forward.process, forward.dispose, platform)
  }
  signal?.addEventListener('abort', dispose, { once: true })
  try {
    signal?.throwIfAborted()
    await waitForSystemSshForwardStartup(
      forward.process,
      forward.localPort,
      SYSTEM_SSH_LOOPBACK_ROUTE_LISTEN_TIMEOUT_MS,
      signal
    )
    const args = { localPort: forward.localPort, hostKeyAlias }
    // Listening alone proves neither sshd forwarding permission nor authentication over the route.
    await probeLoopbackRoute(target, { ...options, loopbackRoute: args }, signal)
    signal?.throwIfAborted()
    return {
      args,
      onExit: (callback) => {
        // Why: the forward can exit between the probe and this registration, after 'exit' already fired.
        if (childProcessHasExited(forward.process)) {
          callback()
          return
        }
        forward.process.once('exit', callback)
      },
      dispose
    }
  } catch (error) {
    dispose()
    throw error
  } finally {
    signal?.removeEventListener('abort', dispose)
  }
}

function stopLoopbackForward(
  forwardProcess: ChildProcess,
  killForward: () => void,
  platform: NodeJS.Platform
): void {
  if (childProcessHasExited(forwardProcess)) {
    return
  }
  if (platform !== 'win32') {
    killForward()
    return
  }
  // Why: Windows does not end a killed ssh's ProxyCommand child, which would keep the proxy tunnel open.
  void signalProcessTree(forwardProcess).catch(killForward)
}

function probeLoopbackRoute(
  target: SshTarget,
  options: SystemSshBuildArgsOptions,
  signal?: AbortSignal
): Promise<void> {
  signal?.throwIfAborted()
  const channel = spawnSystemSshCommand(target, `echo ${LOOPBACK_ROUTE_PROBE_MARKER}`, {
    ...options,
    nonInteractive: true,
    wrapCommand: false
  })
  return new Promise((resolve, reject) => {
    let stdout = ''
    let settled = false
    const finish = (error?: Error, closeChannel = false): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
      channel.off('data', onData)
      channel.off('close', onClose)
      if (error) {
        if (closeChannel) {
          channel.close()
        }
        reject(error)
      } else {
        resolve()
      }
    }
    const onAbort = (): void => finish(createSshOperationAbortError(), true)
    const onData = (data: Buffer): void => {
      stdout += data.toString('utf-8')
    }
    const onClose = (code: number | null): void => {
      finish(
        code === 0 && stdout.includes(LOOPBACK_ROUTE_PROBE_MARKER)
          ? undefined
          : new Error(`System SSH loopback route probe failed (exit ${code ?? 'unknown'})`)
      )
    }
    const timeout = setTimeout(() => {
      finish(new Error('System SSH loopback route probe timed out'), true)
    }, SYSTEM_SSH_LOOPBACK_ROUTE_PROBE_TIMEOUT_MS)
    channel.on('data', onData)
    channel.stderr.resume()
    channel.once('error', (error: Error) => finish(error, true))
    channel.once('close', onClose)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) {
      onAbort()
    }
  })
}

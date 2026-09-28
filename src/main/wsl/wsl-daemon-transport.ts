import { bunOwnedRuntimeArgs } from '../../shared/bun-owned-runtime-args'
import type {
  DaemonClientTransport,
  DaemonTransportOperation
} from '../daemon/daemon-client-transport'
import { runProcess, type ProcessSpec } from '../../shared/child-process/run-process'
import { buildWslExecArgs } from '../../shared/wsl-login-shell-command'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import {
  assertWslAccountExecutionTarget,
  type WslAccountExecutionContext
} from './wsl-account-execution-context'
import { assertWslRuntimeDistroRunning } from './wsl-bun-runtime'
import { readWslDistributionIdentity } from './wsl-distribution-identity'
import { resolveWslExecutablePath } from './wsl-executable-path'
import { resolveWslInteropSpawnCwd } from '../wsl-interop-spawn-directory'
import { openWslDaemonConnectorStream } from './wsl-daemon-connector-stream'
import {
  WSL_DAEMON_CONNECTOR_SCRIPT,
  WSL_DAEMON_READ_TOKEN_SCRIPT
} from './wsl-daemon-connector-script'

export type WslDaemonEndpoint = WslAccountExecutionContext &
  Readonly<{
    distributionId: string
    envBinary: string
    runtime: string
    socket: string
    tokenPath: string
  }>

/** Guest paths and process identities never pass through the Windows filesystem/process probes. */
export function createWslDaemonTransport(value: WslDaemonEndpoint): DaemonClientTransport {
  const endpoint = Object.freeze({ ...value })
  assertWslAccountExecutionTarget(endpoint, { runtime: 'wsl', wslDistro: endpoint.distro })
  if (!endpoint.distributionId || /[\0\r\n]/.test(endpoint.distro)) {
    throw new Error('Invalid WSL daemon identity')
  }
  for (const path of [
    endpoint.home,
    endpoint.envBinary,
    endpoint.runtime,
    endpoint.socket,
    endpoint.tokenPath
  ]) {
    if (!path.startsWith('/') || /[\0\r\n]/.test(path)) {
      throw new Error('WSL daemon requires absolute guest paths')
    }
  }
  const verifyOwner = async ({ signal }: DaemonTransportOperation) => {
    await assertWslRuntimeDistroRunning(endpoint.distro, signal)
    const registration = await waitForPromiseWithSignal(
      readWslDistributionIdentity(endpoint.distro),
      signal
    )
    if (registration !== endpoint.distributionId) {
      throw new Error('WSL distribution was replaced; the terminal owner is unverifiable')
    }
    signal.throwIfAborted()
  }
  const command = (script: string): ProcessSpec => ({
    program: resolveWslExecutablePath(),
    args: buildWslExecArgs(
      endpoint.distro,
      [
        endpoint.envBinary,
        ...[
          'NODE_OPTIONS',
          'NODE_PATH',
          'BUN_OPTIONS',
          'BUN_INSPECT',
          'ELECTRON_RUN_AS_NODE'
        ].flatMap((key) => ['-u', key]),
        endpoint.runtime,
        ...bunOwnedRuntimeArgs('linux'),
        '-e',
        script,
        JSON.stringify(endpoint)
      ],
      endpoint.userName
    ),
    cwd: resolveWslInteropSpawnCwd()
  })
  return {
    async readToken(operation) {
      await verifyOwner(operation)
      const result = await runProcess({
        ...command(WSL_DAEMON_READ_TOKEN_SCRIPT),
        signal: operation.signal,
        timeoutMs: operation.timeoutMs,
        maxOutputBytes: 4096
      })
      operation.signal.throwIfAborted()
      const token = result.stdout.trim()
      if (
        result.code !== 0 ||
        result.timedOut ||
        result.outputTruncated ||
        !token ||
        /[\0\r\n]/.test(token)
      ) {
        throw new Error('WSL daemon authentication token is unavailable')
      }
      return token
    },
    async connect(_role, operation) {
      await verifyOwner(operation)
      return openWslDaemonConnectorStream(command(WSL_DAEMON_CONNECTOR_SCRIPT), operation.signal)
    }
  }
}

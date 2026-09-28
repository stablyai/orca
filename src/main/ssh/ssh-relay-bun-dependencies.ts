import { isUnconfirmedSshCommandTermination, execCommand } from './ssh-relay-deploy-helpers'
import type { SshConnection } from './ssh-connection'
import { shellEscape } from './ssh-connection-utils'
import { commandWithNodePath } from './ssh-remote-commands'
import { isWindowsRemoteHost, joinRemotePath, type RemoteHostPlatform } from './ssh-remote-platform'
import { writeRelayFile } from './ssh-relay-install-transfers'
import {
  relaySftpNamespaceMapping,
  type RelayInstallNamespace
} from './ssh-relay-install-namespace'
import { NATIVE_DEPS_COMMAND_TIMEOUT_MS } from './ssh-relay-deploy-timing'

export const RELAY_BUN_NATIVE_DEPS = { '@parcel/watcher': '2.5.6' } as const

/** POSIX watchers use registry prebuilts; Windows ships its qualified addon. */
export async function installRelayBunDependencies(options: {
  conn: SshConnection
  host: RemoteHostPlatform
  directory: string
  runtime: string
  signal?: AbortSignal
  namespace?: RelayInstallNamespace
  repair?: boolean
}): Promise<void> {
  const { conn, host, directory, runtime, signal, namespace } = options
  signal?.throwIfAborted()
  if (isWindowsRemoteHost(host)) {
    return
  }
  await writeRelayFile(
    conn,
    host,
    joinRemotePath(host, directory, 'package.json'),
    `${JSON.stringify({
      name: 'orca-relay',
      version: '1.0.0',
      private: true,
      type: 'commonjs',
      dependencies: RELAY_BUN_NATIVE_DEPS
    })}\n`,
    {
      signal,
      sftpNamespace: namespace
        ? relaySftpNamespaceMapping(namespace, host, directory, 'package.json')
        : undefined
    }
  )
  const installArgs = `install --ignore-scripts --no-progress${options.repair ? ' --force' : ''}`
  const invocation = `${shellEscape(runtime)} ${installArgs}`
  try {
    await execCommand(conn, commandWithNodePath(host, runtime, directory, invocation), {
      signal,
      timeoutMs: NATIVE_DEPS_COMMAND_TIMEOUT_MS,
      wrapCommand: true
    })
    signal?.throwIfAborted()
  } catch (error) {
    if (isUnconfirmedSshCommandTermination(error)) {
      throw error
    }
    signal?.throwIfAborted()
    console.warn(
      '[ssh-relay] Watcher installation failed; terminal service remains available:',
      error
    )
  }
}

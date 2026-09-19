import { ORCAD_BUN_RUNTIME_FILENAME, orcadBunRuntimeFilename } from '../../shared/orcad-artifacts'
import type { SshConnection } from './ssh-connection'
import { shellEscape } from './ssh-connection-utils'
import { execCommand } from './ssh-relay-deploy-helpers'
import { resolveRemoteNodePath } from './ssh-remote-node-resolution'
import { isWindowsRemoteHost, joinRemotePath, type RemoteHostPlatform } from './ssh-remote-platform'
import { powerShellCommand, powerShellLiteral, powerShellNativeArg } from './ssh-remote-powershell'

export type OrcadSlotRuntime = 'bun' | 'legacy-node' | 'incomplete'

export async function resolveOrcadSlotNodeFallback(
  conn: SshConnection,
  host: RemoteHostPlatform,
  remoteInstallDir: string,
  signal?: AbortSignal
): Promise<string | undefined> {
  const runtime = parseOrcadSlotRuntime(
    await execCommand(conn, probeOrcadSlotRuntimeCommand(host, remoteInstallDir), {
      wrapCommand: host.commandDialect !== 'powershell',
      signal
    })
  )
  if (runtime === 'bun') {
    return undefined
  }
  if (runtime === 'incomplete') {
    throw new Error('The orcad rollback slot is incomplete and cannot be launched.')
  }
  const nodePath = await resolveRemoteNodePath(conn, host, { signal })
  const nativeProbe = await execCommand(
    conn,
    probeLegacyOrcadNativeDependenciesCommand(host, remoteInstallDir, nodePath),
    { wrapCommand: host.commandDialect !== 'powershell', signal }
  )
  if (!nativeProbe.split(/\r?\n/u).some((line) => line.trim() === 'ORCAD_LEGACY_NATIVE_OK')) {
    throw new Error(
      'The pre-Bun orcad rollback slot cannot load its legacy native dependencies under host Node.'
    )
  }
  return nodePath
}

export function probeOrcadSlotRuntimeCommand(
  host: RemoteHostPlatform,
  remoteInstallDir: string
): string {
  const runtime = joinRemotePath(host, remoteInstallDir, orcadBunRuntimeFilename(host.os))
  const entry = joinRemotePath(host, remoteInstallDir, 'orcad.js')
  if (isWindowsRemoteHost(host)) {
    const legacyRuntime = joinRemotePath(host, remoteInstallDir, ORCAD_BUN_RUNTIME_FILENAME)
    return powerShellCommand(
      `if (Test-Path -LiteralPath ${powerShellLiteral(runtime)} -PathType Leaf) { 'BUN' } ` +
        `elseif (Test-Path -LiteralPath ${powerShellLiteral(legacyRuntime)}) { 'INCOMPLETE' } ` +
        `elseif (Test-Path -LiteralPath ${powerShellLiteral(entry)} -PathType Leaf) { 'LEGACY_NODE' } ` +
        `else { 'INCOMPLETE' }`
    )
  }
  return (
    `if [ -x ${shellEscape(runtime)} ]; then echo BUN; ` +
    // Existing runtime with a lost execute bit is corrupt; fail closed instead of falling back to Node.
    `elif [ -e ${shellEscape(runtime)} ] || [ -L ${shellEscape(runtime)} ]; then echo INCOMPLETE; ` +
    `elif [ -f ${shellEscape(entry)} ]; then echo LEGACY_NODE; else echo INCOMPLETE; fi`
  )
}

export function parseOrcadSlotRuntime(output: string): OrcadSlotRuntime {
  const marker = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .findLast((line) => line === 'BUN' || line === 'LEGACY_NODE' || line === 'INCOMPLETE')
  return marker === 'BUN' ? 'bun' : marker === 'LEGACY_NODE' ? 'legacy-node' : 'incomplete'
}

export function probeLegacyOrcadNativeDependenciesCommand(
  host: RemoteHostPlatform,
  remoteInstallDir: string,
  nodePath: string
): string {
  const script =
    `process.chdir(${JSON.stringify(remoteInstallDir)});` +
    `require.resolve('node-pty');require('node-pty');` +
    `process.stdout.write('ORCAD_LEGACY_NATIVE_OK\\n')`
  if (isWindowsRemoteHost(host)) {
    return powerShellCommand(
      `& ${powerShellLiteral(nodePath)} ${powerShellNativeArg('-e')} ${powerShellNativeArg(script)}`
    )
  }
  return `${shellEscape(nodePath)} -e ${shellEscape(script)}`
}

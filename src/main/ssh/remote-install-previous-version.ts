/**
 * The version dir a model ran before the current one, pinned against GC like orcad's
 * rollback target (design D5 "plus the relay's previous version as a pin").
 *
 * The relay keeps no activation record, so "previous" is the most recently completed install
 * of the same model other than the current one, by `.install-complete` mtime.
 */
import type { SshConnection } from './ssh-connection'
import { shellEscape } from './ssh-connection-utils'
import { execCommand } from './ssh-relay-deploy-helpers'
import { isUnconfirmedSshCommandTermination } from './ssh-relay-exec-command'
import {
  remoteInstallGcPermits,
  remoteInstallVersionDirRegex,
  type RemoteInstallModel
} from './remote-install-model'
import { isWindowsRemoteHost, type RemoteHostPlatform } from './ssh-remote-platform'
import { powerShellCommand, powerShellLiteral } from './ssh-remote-powershell'

export const REMOTE_INSTALL_ORDER_OK = 'ORCA_INSTALL_ORDER_OK'

export function listCompletedInstallsNewestFirstCommand(
  host: RemoteHostPlatform,
  baseDir: string,
  model: RemoteInstallModel
): string {
  const prefix = `${model.dirPrefix}-`
  if (isWindowsRemoteHost(host)) {
    return powerShellCommand(
      [
        "$ErrorActionPreference = 'Stop'",
        `$base = ${powerShellLiteral(baseDir)}`,
        'if (Test-Path -LiteralPath $base -PathType Container) {',
        `Get-ChildItem -LiteralPath $base -Directory -Filter '${prefix}*' | ForEach-Object { ` +
          `$marker = Join-Path $_.FullName ${powerShellLiteral(model.installCompleteFilename)}; ` +
          'if (Test-Path -LiteralPath $marker -PathType Leaf) { Get-Item -LiteralPath $marker } ' +
          '} | Sort-Object LastWriteTimeUtc -Descending | ForEach-Object { $_.Directory.Name }',
        '}',
        `'${REMOTE_INSTALL_ORDER_OK}'`
      ].join('\n')
    )
  }
  return [
    `base=${shellEscape(baseDir)}`,
    `set -- "$base"/${prefix}*/${shellEscape(model.installCompleteFilename)}`,
    `[ -e "$1" ] || { echo ${REMOTE_INSTALL_ORDER_OK}; exit 0; }`,
    'ls -1t -- "$@" || exit 1',
    `echo ${REMOTE_INSTALL_ORDER_OK}`
  ].join('\n')
}

/** Dir names newest first, or null when the host could not answer. */
export function parseCompletedInstallsNewestFirst(
  output: string,
  model: RemoteInstallModel
): string[] | null {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (!lines.includes(REMOTE_INSTALL_ORDER_OK)) {
    return null
  }
  const versionDirRegex = remoteInstallVersionDirRegex(model)
  const names: string[] = []
  for (const line of lines) {
    // POSIX prints `<base>/<dir>/.install-complete`; PowerShell prints `<dir>`.
    const segments = line.split(/[\\/]/)
    const name = segments.length > 1 ? segments.at(-2) : segments[0]
    if (name && versionDirRegex.test(name) && remoteInstallGcPermits(model, name)) {
      names.push(name)
    }
  }
  return names
}

export type PreviousInstallResult = { state: 'ok'; dirName: string | null } | { state: 'unknown' }

export async function findPreviousRemoteInstall(
  conn: SshConnection,
  host: RemoteHostPlatform,
  baseDir: string,
  model: RemoteInstallModel,
  currentDirName: string
): Promise<PreviousInstallResult> {
  let output: string
  try {
    output = await execCommand(
      conn,
      listCompletedInstallsNewestFirstCommand(host, baseDir, model),
      {
        wrapCommand: host.commandDialect !== 'powershell'
      }
    )
  } catch (err) {
    if (isUnconfirmedSshCommandTermination(err)) {
      throw err
    }
    return { state: 'unknown' }
  }
  const ordered = parseCompletedInstallsNewestFirst(output, model)
  if (!ordered) {
    return { state: 'unknown' }
  }
  return { state: 'ok', dirName: ordered.find((name) => name !== currentDirName) ?? null }
}

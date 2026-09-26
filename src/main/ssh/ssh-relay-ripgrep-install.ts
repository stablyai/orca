/**
 * Installs Orca's own ripgrep on an SSH host so remote Quick Open and text search do not depend
 * on the user having `rg`. The binary lives at
 * `~/.orca-remote/ripgrep/<content-hash>-<platform>/rg[.exe]`, a sibling of the
 * `relay-<version>` dirs keyed on the binary's bytes alone, so a relay upgrade never re-uploads it.
 *
 * Uploads land in a private `.upload-<token>` stage and are renamed into place only after a size
 * check, so an interrupted or concurrent deploy never leaves a truncated binary at the final path.
 * Every failure is reported, never thrown: the relay falls back to PATH `rg` and its git/readdir
 * chain, which is exactly what it did before this binary existed.
 */
import { randomBytes } from 'node:crypto'
import { statSync } from 'node:fs'
import { dirname } from 'node:path'
import type { SshConnection } from './ssh-connection'
import { RELAY_REMOTE_DIR } from './relay-protocol'
import { execCommand } from './ssh-relay-deploy-helpers'
import { uploadRelayDirectory } from './ssh-relay-install-transfers'
import {
  createRelayUploadStageNamespace,
  makeRelayUploadStageDirectoryCommand,
  relayUploadStageSftpNamespaceMapping,
  type RelayUploadStageNamespace
} from './ssh-relay-install-namespace'
import { shellEscape } from './ssh-connection-utils'
import { powerShellCommand, powerShellLiteral } from './ssh-remote-powershell'
import {
  assertSafeRemotePathSegment,
  isWindowsRemoteHost,
  joinRemotePath,
  remoteDirname,
  type RemoteHostPlatform
} from './ssh-remote-platform'
import { removeRemoteTreeCommand } from './ssh-remote-commands'
import {
  bundledRipgrepContentKey,
  resolveBundledRipgrepPath
} from '../ripgrep/bundled-ripgrep-path'
import {
  bundledRipgrepBinaryName,
  toBundledRipgrepPlatform,
  type BundledRipgrepPlatform
} from '../../shared/bundled-ripgrep'

/** Sibling of `relay-<version>`, `orcad-<version>` and `native/`. */
export const REMOTE_RIPGREP_CACHE_DIR_NAME = 'ripgrep'

// Ripgrep-only updates share relay bytes, so one relay directory can reference multiple builds.
export const REMOTE_RIPGREP_REF_PREFIX = '.ripgrep-ref-'

export function remoteRipgrepRefFileName(entryName: string): string {
  return `${REMOTE_RIPGREP_REF_PREFIX}${entryName}`
}

/** Record which ripgrep build a relay directory runs against. Best-effort: never fails a deploy. */
export async function recordRemoteRipgrepReference(
  conn: SshConnection,
  host: RemoteHostPlatform,
  relayDir: string,
  entryName: string
): Promise<boolean> {
  const refPath = joinRemotePath(host, relayDir, remoteRipgrepRefFileName(entryName))
  try {
    assertSafeRemotePathSegment(entryName, host.pathFlavor)
    await execCommand(
      conn,
      isWindowsRemoteHost(host)
        ? powerShellCommand(
            `Set-Content -LiteralPath ${powerShellLiteral(refPath)} -Value ${powerShellLiteral(entryName)} -NoNewline -Encoding ascii`
          )
        : `printf %s ${shellEscape(entryName)} > ${shellEscape(refPath)}`,
      { wrapCommand: !isWindowsRemoteHost(host) }
    )
    return true
  } catch (error) {
    console.warn(
      '[ssh-relay] Could not record the ripgrep reference; skipping the bundled binary:',
      error instanceof Error ? error.message : String(error)
    )
    return false
  }
}
const UPLOAD_STAGE_PREFIX = '.upload-'
// Why an hour: long enough that no live upload of ~5 MB is still writing, short enough to drain crashes.
const STALE_UPLOAD_STAGE_MINUTES = 60
const PRESENT = 'ORCA-RG-PRESENT'
const STAGED = 'ORCA-RG-STAGED'
const INSTALLED = 'ORCA-RG-INSTALLED'

export type RemoteRipgrepLayout = {
  platform: BundledRipgrepPlatform
  cacheDir: string
  /** `<content-hash>-<platform>`; the sibling directories are superseded builds. */
  entryName: string
  binaryPath: string
}

export type RemoteRipgrepInstallOutcome = 'present' | 'installed' | 'unavailable' | 'failed'

export function remoteRipgrepLayout(
  host: RemoteHostPlatform,
  remoteHome: string
): RemoteRipgrepLayout | null {
  const platform = toBundledRipgrepPlatform(host.os, host.arch)
  const contentKey = platform ? bundledRipgrepContentKey(platform) : null
  if (!platform || !contentKey) {
    return null
  }
  const entryName = `${contentKey}-${platform}`
  assertSafeRemotePathSegment(entryName, host.pathFlavor)
  const cacheDir = joinRemotePath(host, remoteHome, RELAY_REMOTE_DIR, REMOTE_RIPGREP_CACHE_DIR_NAME)
  return {
    platform,
    cacheDir,
    entryName,
    binaryPath: joinRemotePath(host, cacheDir, entryName, bundledRipgrepBinaryName(platform))
  }
}

/** Make sure the host has Orca's ripgrep at `remoteRipgrepLayout().binaryPath`; never throws. */
export async function ensureRemoteBundledRipgrep(
  conn: SshConnection,
  host: RemoteHostPlatform,
  remoteHome: string,
  options: { signal?: AbortSignal; relayDir?: string } = {}
): Promise<RemoteRipgrepInstallOutcome> {
  const layout = remoteRipgrepLayout(host, remoteHome)
  if (options.relayDir && layout && resolveBundledRipgrepPath(layout.platform)) {
    if (!(await recordRemoteRipgrepReference(conn, host, options.relayDir, layout.entryName))) {
      return 'failed'
    }
  }
  return installOrReport(conn, host, remoteHome, options)
}

async function installOrReport(
  conn: SshConnection,
  host: RemoteHostPlatform,
  remoteHome: string,
  options: { signal?: AbortSignal } = {}
): Promise<RemoteRipgrepInstallOutcome> {
  try {
    const layout = remoteRipgrepLayout(host, remoteHome)
    const localBinary = layout ? resolveBundledRipgrepPath(layout.platform) : null
    if (!layout || !localBinary) {
      console.warn(
        `[ssh-relay] No bundled ripgrep for ${host.relayPlatform}; the relay will use rg from PATH`
      )
      return 'unavailable'
    }
    return await installRemoteRipgrep(conn, host, layout, localBinary, options.signal)
  } catch (error) {
    console.warn(
      '[ssh-relay] Bundled ripgrep install failed; the relay will use rg from PATH:',
      error instanceof Error ? error.message : String(error)
    )
    return 'failed'
  }
}

async function installRemoteRipgrep(
  conn: SshConnection,
  host: RemoteHostPlatform,
  layout: RemoteRipgrepLayout,
  localBinary: string,
  signal: AbortSignal | undefined
): Promise<RemoteRipgrepInstallOutcome> {
  const exec = (command: string): Promise<string> =>
    execCommand(conn, command, { wrapCommand: !isWindowsRemoteHost(host), signal })
  const stageName = `${UPLOAD_STAGE_PREFIX}${randomBytes(8).toString('hex')}`
  const stageDir = joinRemotePath(host, layout.cacheDir, stageName)
  const stageNamespace = createRelayUploadStageNamespace(
    `${RELAY_REMOTE_DIR}/${REMOTE_RIPGREP_CACHE_DIR_NAME}/${stageName}`
  )

  const size = statSync(localBinary).size
  // Why one round trip: the warm path (already installed) must cost a single exec.
  const probe = await exec(probeOrStageCommand(host, layout, stageDir, stageNamespace, size))
  if (probe.includes(PRESENT)) {
    return 'present'
  }
  if (!probe.includes(STAGED)) {
    throw new Error(`could not stage upload: ${probe.trim().slice(0, 200)}`)
  }

  let promoted = false
  try {
    await uploadRelayDirectory(
      conn,
      dirname(localBinary),
      joinRemotePath(host, stageDir, 'payload'),
      host,
      {
        signal,
        sftpNamespace: usesOrcaOwnedSftp(conn, host)
          ? relayUploadStageSftpNamespaceMapping(stageNamespace, host, stageDir)
          : undefined
      }
    )
    const result = await exec(promoteCommand(host, layout, stageDir, size))
    promoted = true
    if (!result.includes(INSTALLED)) {
      throw new Error(`upload did not verify: ${result.trim().slice(0, 200)}`)
    }
    console.log(`[ssh-relay] Installed bundled ripgrep at ${layout.binaryPath} (${size} bytes)`)
    return 'installed'
  } finally {
    if (!promoted) {
      // Why best-effort: the next deploy's probe also sweeps stale stages.
      await execCommand(conn, removeRemoteTreeCommand(host, stageDir), {
        wrapCommand: !isWindowsRemoteHost(host)
      }).catch(() => {})
    }
  }
}

/** Split shell/SFTP namespaces only arise on POSIX hosts reached over the bundled ssh2 SFTP. */
function usesOrcaOwnedSftp(conn: SshConnection, host: RemoteHostPlatform): boolean {
  if (isWindowsRemoteHost(host)) {
    return false
  }
  return typeof conn.usesSystemSshTransport === 'function' ? !conn.usesSystemSshTransport() : true
}

// Why size: the path is content-keyed, so a wrong length can only be a truncated or foreign file.
function posixInstalledTest(bin: string, bytes: string): string {
  return `[ -f ${bin} ] && [ -x ${bin} ] && [ "$(wc -c < ${bin} 2>/dev/null | tr -d ' \\t')" = "${bytes}" ]`
}

function windowsInstalledTest(bin: string, bytes: string): string {
  return `(Test-Path -LiteralPath ${bin} -PathType Leaf) -and ((Get-Item -LiteralPath ${bin}).Length -eq ${bytes})`
}

export function probeOrStageCommand(
  host: RemoteHostPlatform,
  layout: RemoteRipgrepLayout,
  stageDir: string,
  stageNamespace: RelayUploadStageNamespace,
  expectedBytes: number
): string {
  const bytes = String(Math.trunc(expectedBytes))
  if (!isWindowsRemoteHost(host)) {
    const bin = shellEscape(layout.binaryPath)
    const cache = shellEscape(layout.cacheDir)
    const sweep = `find ${cache} -mindepth 1 -maxdepth 1 -type d -name '${UPLOAD_STAGE_PREFIX}*' -mmin +${STALE_UPLOAD_STAGE_MINUTES} -exec rm -rf {} + 2>/dev/null`
    // Installed builds may still serve an older client's live relay; age is not disuse.
    const stage = makeRelayUploadStageDirectoryCommand(stageNamespace, host, stageDir)
    // Why the sweep runs before the branch, not inside the else: once rg is installed every later
    // deploy takes the PRESENT path, so a stage orphaned by a dropped connection would never be
    // collected. It stays one exec round trip either way.
    return `${sweep}; if ${posixInstalledTest(bin, bytes)}; then echo ${PRESENT}; else ${stage} && echo ${STAGED}; fi`
  }
  return powerShellCommand(
    [
      `Get-ChildItem -LiteralPath ${powerShellLiteral(layout.cacheDir)} -Directory -Filter '${UPLOAD_STAGE_PREFIX}*' -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -lt (Get-Date).AddMinutes(-${STALE_UPLOAD_STAGE_MINUTES}) } | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue`,
      `if (${windowsInstalledTest(powerShellLiteral(layout.binaryPath), bytes)}) { '${PRESENT}' } else {`,
      `$null = New-Item -ItemType Directory -Force -Path ${powerShellLiteral(joinRemotePath(host, stageDir, 'payload'))} -ErrorAction Stop`,
      `'${STAGED}' }`
    ].join('\n')
  )
}

/** Verify the staged size, then rename into place; a concurrent winner's binary also counts. */
export function promoteCommand(
  host: RemoteHostPlatform,
  layout: RemoteRipgrepLayout,
  stageDir: string,
  expectedBytes: number
): string {
  const staged = joinRemotePath(
    host,
    stageDir,
    'payload',
    bundledRipgrepBinaryName(layout.platform)
  )
  if (!isWindowsRemoteHost(host)) {
    const src = shellEscape(staged)
    const bin = shellEscape(layout.binaryPath)
    const bytes = String(Math.trunc(expectedBytes))
    return [
      `if [ "$(wc -c < ${src} 2>/dev/null | tr -d ' \\t')" = "${bytes}" ] && chmod 755 ${src} && mkdir -p ${shellEscape(remoteDirname(layout.binaryPath, host))} && mv -f ${src} ${bin}; then r=${INSTALLED};`,
      `elif ${posixInstalledTest(bin, bytes)}; then r=${INSTALLED}; else r=ORCA-RG-FAILED; fi;`,
      `rm -rf ${shellEscape(stageDir)}; echo "$r"`
    ].join(' ')
  }
  return powerShellCommand(
    [
      `$src = ${powerShellLiteral(staged)}`,
      `$bin = ${powerShellLiteral(layout.binaryPath)}`,
      "$r = 'ORCA-RG-FAILED'",
      'try {',
      `if ((Get-Item -LiteralPath $src -ErrorAction Stop).Length -eq ${Math.trunc(expectedBytes)}) {`,
      `$null = New-Item -ItemType Directory -Force -Path ${powerShellLiteral(remoteDirname(layout.binaryPath, host))} -ErrorAction Stop`,
      // Why replace only a wrong-size file: a running relay may hold a good rg.exe open.
      `if (-not (${windowsInstalledTest('$bin', String(Math.trunc(expectedBytes)))})) { Move-Item -LiteralPath $src -Destination $bin -Force -ErrorAction Stop }`,
      `$r = '${INSTALLED}'`,
      '}',
      `} catch { if (${windowsInstalledTest('$bin', String(Math.trunc(expectedBytes)))}) { $r = '${INSTALLED}' } }`,
      `finally { Remove-Item -LiteralPath ${powerShellLiteral(stageDir)} -Recurse -Force -ErrorAction SilentlyContinue }`,
      '$r'
    ].join('\n')
  )
}

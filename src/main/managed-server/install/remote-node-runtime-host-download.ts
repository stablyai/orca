// Hosts may have routes/proxies the desktop lacks; archive and executable hashes still enforce the pin.
import { copyFile, link, mkdtemp } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { nodeDistMirrorUrl, type NodeDistMirrorAttempt } from '../../../shared/node-dist-mirror'
import {
  NODE_RUNTIME_PIN,
  nodeRuntimeReleaseUrl,
  pinnedNodeRuntimeAsset,
  type NodeRuntimeTarget
} from '../../../shared/node-runtime-pin'
import { quotePosixShell } from '../../../shared/shell-argument-quoting'
import {
  isWindowsRemoteHost,
  joinRemotePath,
  type RemoteHostPlatform
} from '../../ssh/ssh-remote-platform'
import { configuredNodeDistMirror } from '../../node-runtime/node-dist-mirror-setting'
import { DesktopDownloadUnreachableError } from '../../node-runtime/pinned-runtime-materializer'
import { remoteSha256Command } from './remote-sha256-command'

export const HOST_NODE_DOWNLOAD_OK = 'ORCA_NODE_HOST_DOWNLOAD_OK'
export const HOST_NODE_DOWNLOAD_FAILED = 'ORCA_NODE_HOST_DOWNLOAD_FAILED'
export const HOST_NODE_DOWNLOAD_NO_TOOL = 'ORCA_NODE_HOST_DOWNLOAD_NO_TOOL'
// One shared budget permits ~70 KB/s downloads without multiplying timeouts per source.
const HOST_DOWNLOAD_BUDGET_SECONDS = 840
const HOST_DOWNLOAD_MIN_ATTEMPT_SECONDS = 30
// ulimit -f counts 512-byte blocks; match the desktop's 200 MiB cap.
const HOST_DOWNLOAD_MAX_BLOCKS = (200 * 1024 * 1024) / 512
// Leave exec time for hashing and reporting after the download budget expires.
const HOST_NODE_DOWNLOAD_TIMEOUT_MS = (HOST_DOWNLOAD_BUDGET_SECONDS + 120) * 1000

const HOST_NODE_DOWNLOAD_NOT_PINNED =
  'the file is not the pinned release (a proxy or filter may have replaced it, or the host lacks sha256sum and shasum)'

export function hostNodeRuntimeUrl(target: NodeRuntimeTarget): string {
  const asset = pinnedNodeRuntimeAsset(target)
  return nodeRuntimeReleaseUrl(asset.source, asset.archive)
}

/** Accept only a pinned archive; exit 0 with a status marker even when downloading fails. */
export function hostDownloadNodeRuntimeCommand(
  host: RemoteHostPlatform,
  args: { stageDir: string; target: NodeRuntimeTarget; mirror?: string | null }
): string {
  const asset = pinnedNodeRuntimeAsset(args.target)
  const file = quotePosixShell(joinRemotePath(host, args.stageDir, asset.archive))
  // Mirrors carry only the official tree; unofficial builds have one fixed source.
  const official = asset.source === 'official'
  const desktopMirror =
    official && args.mirror
      ? nodeDistMirrorUrl(args.mirror, NODE_RUNTIME_PIN.version, asset.archive)
      : null
  const sources = [
    desktopMirror
      ? `orca_dl_get 'the mirror set on this computer' ${quotePosixShell(desktopMirror)}`
      : null,
    `orca_dl_get ${quotePosixShell(new URL(hostNodeRuntimeUrl(args.target)).host)} ${quotePosixShell(hostNodeRuntimeUrl(args.target))}`
  ].filter((line): line is string => line !== null)
  const min = HOST_DOWNLOAD_MIN_ATTEMPT_SECONDS
  // Bound endless mirror/proxy responses so they cannot fill the host disk.
  const sizeCap = `ulimit -f ${HOST_DOWNLOAD_MAX_BLOCKS} 2>/dev/null`
  // wget lacks a total timeout; a silent watchdog avoids host-specific timeout commands and open SSH captures.
  const wget =
    `wget -q -T 20 -t 1 -O ${file} "$2" & orca_dl_pid=$!; ` +
    // Kill the watchdog's sleep too so it cannot linger after wget exits.
    `(trap 'kill "$orca_dl_z" 2>/dev/null; exit 0' TERM; sleep "$orca_dl_t" & orca_dl_z=$!; ` +
    'wait "$orca_dl_z" && kill "$orca_dl_pid") </dev/null >/dev/null 2>&1 & orca_dl_dog=$!; ' +
    'wait "$orca_dl_pid"; orca_dl_s=$?; kill "$orca_dl_dog" 2>/dev/null; exit "$orca_dl_s"'
  const curl = `curl -fsSLg --connect-timeout 20 --max-time "$orca_dl_t" -o ${file} "$2"`
  return [
    'orca_dl_ok=; orca_dl_out=; orca_dl_tool=',
    'if command -v curl >/dev/null 2>&1; then orca_dl_tool=curl; elif command -v wget >/dev/null 2>&1; then orca_dl_tool=wget; fi',
    `orca_dl_n=${sources.length}`,
    'orca_dl_end=$(date +%s 2>/dev/null)',
    `case "$orca_dl_end" in ''|*[!0-9]*) orca_dl_end= ;; *) orca_dl_end=$((orca_dl_end + ${HOST_DOWNLOAD_BUDGET_SECONDS})) ;; esac`,
    // Share remaining time evenly so stalled mirrors cannot starve later sources.
    'orca_dl_get() {',
    '  [ -z "$orca_dl_ok" ] || return 0',
    `  if [ -n "$orca_dl_end" ]; then orca_dl_t=$(((orca_dl_end - $(date +%s)) / orca_dl_n)); else orca_dl_t=${Math.floor(HOST_DOWNLOAD_BUDGET_SECONDS / sources.length)}; fi`,
    '  orca_dl_n=$((orca_dl_n - 1))',
    `  if [ "$orca_dl_t" -lt ${min} ]; then orca_dl_out="$orca_dl_out\${orca_dl_out:+; }$1: not tried, out of time"; return 0; fi`,
    `  if [ "$orca_dl_tool" = curl ]; then orca_dl_said=$( (${sizeCap}; ${curl}) 2>&1 ); orca_dl_try=$?`,
    `  else orca_dl_said=$( (${sizeCap}; ${wget}) 2>&1 ); orca_dl_try=$?; fi`,
    `  if [ "$orca_dl_try" = 0 ] && [ "$(${remoteSha256Command(file)})" = ${quotePosixShell(asset.archiveSha256)} ]; then orca_dl_ok=1; return 0; fi`,
    `  rm -f ${file}`,
    `  [ "$orca_dl_try" = 0 ] && orca_dl_said='${HOST_NODE_DOWNLOAD_NOT_PINNED}'`,
    '  orca_dl_out="$orca_dl_out${orca_dl_out:+; }$1: $orca_dl_tool exit $orca_dl_try${orca_dl_said:+, $orca_dl_said}"',
    '}',
    `if [ -z "$orca_dl_tool" ]; then echo ${HOST_NODE_DOWNLOAD_NO_TOOL}; else`,
    ...sources,
    `if [ -n "$orca_dl_ok" ]; then echo ${HOST_NODE_DOWNLOAD_OK}; else echo ${HOST_NODE_DOWNLOAD_FAILED}; printf '%s\\n' "$orca_dl_out" | head -c 3000; fi`,
    'fi'
  ].join('\n')
}

type HostNodeDownloadResult = { ok: true } | { ok: false; report: string }

export function readHostNodeDownload(output: string): HostNodeDownloadResult {
  const lines = output.trim().split(/\r?\n/)
  if (lines.at(-1)?.trim() === HOST_NODE_DOWNLOAD_OK) {
    return { ok: true }
  }
  if (lines.some((line) => line.trim() === HOST_NODE_DOWNLOAD_NO_TOOL)) {
    return { ok: false, report: 'it has neither curl nor wget' }
  }
  const failed = output.indexOf(HOST_NODE_DOWNLOAD_FAILED)
  if (failed !== -1) {
    const words = output.slice(failed + HOST_NODE_DOWNLOAD_FAILED.length).trim()
    return { ok: false, report: `its downloads failed${words ? ` (${words})` : ''}` }
  }
  return { ok: false, report: `it gave an unexpected reply: ${output.trim().slice(0, 500)}` }
}

export class NodeRuntimeUnreachableError extends Error {
  constructor(
    readonly url: string,
    readonly hostReport: string,
    readonly offlineArchivePath: string | undefined,
    cause: unknown,
    /** Mirror-attempt metadata for setup failures; do not infer it from error text. */
    readonly mirror: NodeDistMirrorAttempt = 'unset'
  ) {
    const desktop =
      cause instanceof DesktopDownloadUnreachableError
        ? cause.reason
        : cause instanceof Error
          ? cause.message
          : String(cause)
    const mirrorAdvice =
      mirror === 'unsupported'
        ? ''
        : `, ${mirror === 'tried' ? 'check the' : 'set a'} mirror of nodejs.org/dist in Settings > ` +
          'Advanced > Network > Node.js download mirror ' +
          "(or NODEJS_ORG_MIRROR in this computer's environment)"
    const offline = offlineArchivePath
      ? `, or download that file on another machine and copy it to ${offlineArchivePath} on this computer.`
      : '.'
    super(
      `Neither this computer nor the host could download Node from ${url}. ` +
        `This computer: ${desktop}. The host: ${hostReport}. ` +
        `Check the network or proxy on either machine and connect again${mirrorAdvice}${offline}`,
      { cause }
    )
    this.name = 'NodeRuntimeUnreachableError'
  }
}

async function downloadNodeRuntimeOnHost(args: {
  exec: (command: string, options: { signal?: AbortSignal; timeoutMs?: number }) => Promise<string>
  host: RemoteHostPlatform
  stageDir: string
  target: NodeRuntimeTarget
  desktopError: unknown
  offlineArchivePath?: string
  timeoutMs: number
  signal?: AbortSignal
}): Promise<string> {
  const mirror = configuredNodeDistMirror()
  const output = await args.exec(
    hostDownloadNodeRuntimeCommand(args.host, {
      stageDir: args.stageDir,
      target: args.target,
      mirror
    }),
    { signal: args.signal, timeoutMs: args.timeoutMs }
  )
  const result = readHostNodeDownload(output)
  if (!result.ok) {
    throw new NodeRuntimeUnreachableError(
      hostNodeRuntimeUrl(args.target),
      result.report,
      args.offlineArchivePath,
      args.desktopError,
      pinnedNodeRuntimeAsset(args.target).source !== 'official'
        ? 'unsupported'
        : mirror
          ? 'tried'
          : 'unset'
    )
  }
  console.warn(
    `[orcad] This computer couldn't download Node, so the host downloaded it: ${String(args.desktopError)}`
  )
  return pinnedNodeRuntimeAsset(args.target).archive
}

export async function stageNodeRuntimeArchive(args: {
  host: RemoteHostPlatform
  target: NodeRuntimeTarget
  stageDir: string
  archivePath: () => Promise<string>
  offlineArchivePath?: string
  exec: (command: string, options: { signal?: AbortSignal; timeoutMs?: number }) => Promise<string>
  upload: (localDir: string) => Promise<void>
  /** Expose the local stage immediately for caller cleanup. */
  onLocalStage: (localDir: string) => void
  signal?: AbortSignal
}): Promise<{ archive: string }> {
  let archivePath: string
  try {
    archivePath = await args.archivePath()
  } catch (desktopError) {
    // Hash failures can be proxy block pages, so allow host download after any acquisition failure.
    if (isWindowsRemoteHost(args.host) || args.signal?.aborted) {
      throw desktopError
    }
    return {
      archive: await downloadNodeRuntimeOnHost({
        ...args,
        desktopError,
        timeoutMs: HOST_NODE_DOWNLOAD_TIMEOUT_MS
      })
    }
  }
  const uploadDir = await mkdtemp(join(dirname(archivePath), '.runtime-upload-'))
  args.onLocalStage(uploadDir)
  const archive = basename(archivePath)
  await link(archivePath, join(uploadDir, archive)).catch(() =>
    copyFile(archivePath, join(uploadDir, archive))
  )
  await args.upload(uploadDir)
  return { archive }
}

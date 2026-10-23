/**
 * The host's own download of the pinned Node archive, tried only when this computer couldn't
 * produce it: many networks give the host a route, or a proxy in its environment, that the
 * desktop lacks. The archive hash is checked here and the promote re-checks the executable, so
 * where the bytes came from never decides what is accepted.
 */
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
/** One wall-clock budget for every source: ~70 KB/s still fetches the ~58 MB archive. */
const HOST_DOWNLOAD_BUDGET_SECONDS = 840
/** Below this an attempt can't finish, so the source is reported as not tried. */
const HOST_DOWNLOAD_MIN_ATTEMPT_SECONDS = 30
/** The desktop downloader's 200 MiB limit, in the 512-byte blocks `ulimit -f` counts. */
const HOST_DOWNLOAD_MAX_BLOCKS = (200 * 1024 * 1024) / 512
/** The budget plus the hash and the report, so the script always answers before the exec gives up. */
const HOST_NODE_DOWNLOAD_TIMEOUT_MS = (HOST_DOWNLOAD_BUDGET_SECONDS + 120) * 1000

const HOST_NODE_DOWNLOAD_NOT_PINNED =
  'the file is not the pinned release (a proxy or filter may have replaced it, or the host lacks sha256sum and shasum)'

export function hostNodeRuntimeUrl(target: NodeRuntimeTarget): string {
  const asset = pinnedNodeRuntimeAsset(target)
  return nodeRuntimeReleaseUrl(asset.source, asset.archive)
}

/**
 * Downloads into the installer's stage from this computer's mirror, then the release URL, with
 * curl or else wget. Only URLs Orca validated are used, so no host secret can reach the report.
 * Keeps the file only if it hashes to the pin, and always exits 0 with a marker.
 */
export function hostDownloadNodeRuntimeCommand(
  host: RemoteHostPlatform,
  args: { stageDir: string; target: NodeRuntimeTarget; mirror?: string | null }
): string {
  const asset = pinnedNodeRuntimeAsset(args.target)
  const file = quotePosixShell(joinRemotePath(host, args.stageDir, asset.archive))
  // Mirrors carry the official tree only; unofficial builds live at one address.
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
  // Why ulimit: a proxy or mirror serving endless bytes would otherwise fill the host's disk.
  const sizeCap = `ulimit -f ${HOST_DOWNLOAD_MAX_BLOCKS} 2>/dev/null`
  // wget has no total-time limit, and `timeout` varies by host, so a backgrounded sleep bounds it.
  // The watchdog's output goes to /dev/null so it never holds the capture or the SSH channel open.
  const wget =
    `wget -q -T 20 -t 1 -O ${file} "$2" & orca_dl_pid=$!; ` +
    // The trap takes the sleep down with the watchdog, so nothing lingers once wget is done.
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
    // Each source gets an even share of what is left, so a stalled mirror can't starve the release
    // URL, and the last source inherits whatever the others didn't use.
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

/** Whether the archive is now in the stage; otherwise the host's reason, in plain words. */
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

/** Neither this computer nor the host could get the pinned archive; says what is left to try. */
export class NodeRuntimeUnreachableError extends Error {
  constructor(
    readonly url: string,
    readonly hostReport: string,
    readonly offlineArchivePath: string | undefined,
    cause: unknown,
    /** Whether both attempts tried a mirror; the setup failure reads this, never the text. */
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

/**
 * Runs the host download after this computer's attempt failed with `desktopError`, and returns the
 * archive's name in the stage; throws one error naming both attempts when the host fails too.
 */
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

/**
 * Puts the pinned archive in the host stage: this computer's verified copy, uploaded, or else the
 * host's own download. Returns the archive's name there.
 */
export async function stageNodeRuntimeArchive(args: {
  host: RemoteHostPlatform
  target: NodeRuntimeTarget
  stageDir: string
  archivePath: () => Promise<string>
  offlineArchivePath?: string
  exec: (command: string, options: { signal?: AbortSignal; timeoutMs?: number }) => Promise<string>
  upload: (localDir: string) => Promise<void>
  /** Receives the local upload directory as soon as it exists, so the caller can remove it. */
  onLocalStage: (localDir: string) => void
  signal?: AbortSignal
}): Promise<{ archive: string }> {
  let archivePath: string
  try {
    archivePath = await args.archivePath()
  } catch (desktopError) {
    // Why any failure: a proxy's block page fails the hash just as a refused connect fails.
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

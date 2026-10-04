/**
 * Puts the pinned Node beside the orcad slots, at `runtimes/node-<executableSha256>/bin/node`
 * (design D2/D5), where `selectOrcadSlotRuntimeCommand` resolves a slot's `.runtime-node`.
 * The OpenCode vault reader uses the same store on SSH and WSL hosts (design D4a).
 *
 * The official archive is uploaded as published and extracted on the host; the executable's
 * hash is checked there before it is published. Promotion runs under the store lock that
 * store GC also takes (design D5); nothing here deletes a runtime.
 */
import { randomBytes } from 'node:crypto'
import { copyFile, link, mkdtemp, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import {
  pinnedNodeRuntimeAsset,
  NODE_RUNTIME_PIN,
  nodeRuntimeExecutablePath,
  type NodeRuntimeTarget
} from '../../shared/node-runtime-pin'
import {
  ORCAD_NODE_RUNTIME_DIR_PREFIX,
  ORCAD_NODE_RUNTIME_POSIX_EXECUTABLE,
  ORCAD_RUNTIMES_DIRNAME,
  orcadNodeRuntimeExecutable
} from '../../shared/orcad-artifacts'
import type { SshConnection } from './ssh-connection'
import { shellEscape } from './ssh-connection-utils'
import { execCommand } from './ssh-relay-deploy-helpers'
import { isUnconfirmedSshCommandTermination } from './ssh-relay-exec-command'
import { uploadRelayDirectory } from './ssh-relay-install-transfers'
import {
  isWindowsRemoteHost,
  joinRemotePath,
  remoteDirname,
  type RemoteHostPlatform
} from './ssh-remote-platform'
import { assertPosixOrcadHost } from './orcad-remote-host-support'
import { withRuntimeStoreLock } from './remote-node-runtime-store-lock'
import {
  assertRemoteNodeRuntimePromoted,
  REMOTE_NODE_RUNTIME_EXIT_PREFIX,
  REMOTE_NODE_RUNTIME_MISSING,
  REMOTE_NODE_RUNTIME_READY,
  REMOTE_NODE_RUNTIME_SELFTEST_FAILED,
  REMOTE_NODE_RUNTIME_VERIFIED_MARKER
} from './orcad-remote-node-runtime-report'
import {
  windowsNodeRuntimePresentCommand,
  windowsNodeRuntimeProbeCommand,
  windowsNodeRuntimePromoteCommand,
  windowsNodeRuntimeStageCleanupCommand,
  WINDOWS_NODE_RUNTIME_PROMOTE_TIMEOUT_MS
} from './orcad-remote-node-runtime-windows'

export {
  parseRemoteRuntimeExitReport,
  REMOTE_NODE_RUNTIME_EXIT_PREFIX,
  REMOTE_NODE_RUNTIME_MISSING,
  REMOTE_NODE_RUNTIME_READY,
  REMOTE_NODE_RUNTIME_SECURITY_MODIFIED,
  REMOTE_NODE_RUNTIME_SELFTEST_FAILED,
  RemoteNodeRuntimeSecurityModifiedError,
  RemoteNodeRuntimeSelfTestError
} from './orcad-remote-node-runtime-report'
const VERIFIED_MARKER = REMOTE_NODE_RUNTIME_VERIFIED_MARKER
/** Upload stages sit in the store beside the runtimes they become; store GC sweeps stale ones. */
export const RUNTIME_STORE_STAGE_PREFIX = '.stage-'

/** `<storeParent>/runtimes/node-<executableSha256>`, the one host layout (design D5). */
export function nodeRuntimeStoreDir(
  host: RemoteHostPlatform,
  storeParent: string,
  target: NodeRuntimeTarget
): string {
  return joinRemotePath(
    host,
    storeParent,
    ORCAD_RUNTIMES_DIRNAME,
    `${ORCAD_NODE_RUNTIME_DIR_PREFIX}${pinnedNodeRuntimeAsset(target).executableSha256}`
  )
}

/**
 * The runtime directory beside a version dir (an orcad slot or a relay install); the slot
 * selector computes the same path, and the vault reader shares the store.
 */
export function remoteNodeRuntimeDir(
  host: RemoteHostPlatform,
  slotDir: string,
  target: NodeRuntimeTarget
): string {
  return nodeRuntimeStoreDir(host, remoteDirname(slotDir.replace(/\/+$/, ''), host), target)
}

/** The executable inside a POSIX runtime directory. */
export function posixNodeRuntimeExecutable(host: RemoteHostPlatform, runtimeDir: string): string {
  return joinRemotePath(host, runtimeDir, ...ORCAD_NODE_RUNTIME_POSIX_EXECUTABLE.split('/'))
}

/** A per-installer stage beside the runtime; its dot prefix keeps it out of `node-*` listings. */
export function nodeRuntimeStageDir(
  host: RemoteHostPlatform,
  runtimeDir: string,
  token: string
): string {
  return joinRemotePath(
    host,
    remoteDirname(runtimeDir, host),
    `${RUNTIME_STORE_STAGE_PREFIX}${basename(runtimeDir)}-${token}`
  )
}

// Why both tools: GNU/busybox ship sha256sum, macOS ships shasum; either prints the digest first.
function sha256Of(path: string): string {
  return `{ sha256sum ${path} 2>/dev/null || shasum -a 256 ${path}; } | cut -d' ' -f1`
}

/** Ready only when the executable hashes to the pin and reports the pinned version. */
export function probeRemoteNodeRuntimeCommand(
  host: RemoteHostPlatform,
  runtimeDir: string,
  target: NodeRuntimeTarget
): string {
  if (isWindowsRemoteHost(host)) {
    return windowsNodeRuntimeProbeCommand(runtimeDir, target)
  }
  const executable = shellEscape(posixNodeRuntimeExecutable(host, runtimeDir))
  const verified = shellEscape(joinRemotePath(host, runtimeDir, VERIFIED_MARKER))
  return (
    `if [ -f ${verified} ] && [ -x ${executable} ] && ` +
    `[ "$(${sha256Of(executable)})" = ${shellEscape(pinnedNodeRuntimeAsset(target).executableSha256)} ]; ` +
    `then echo ${REMOTE_NODE_RUNTIME_READY}; else echo ${REMOTE_NODE_RUNTIME_MISSING}; fi`
  )
}

/** Cheap warm-path check: a published runtime has its marker and an executable; no re-hash. */
export function remoteNodeRuntimePresentCommand(
  host: RemoteHostPlatform,
  runtimeDir: string
): string {
  if (isWindowsRemoteHost(host)) {
    return windowsNodeRuntimePresentCommand(runtimeDir)
  }
  const executable = shellEscape(
    joinRemotePath(host, runtimeDir, ...ORCAD_NODE_RUNTIME_POSIX_EXECUTABLE.split('/'))
  )
  const verified = shellEscape(joinRemotePath(host, runtimeDir, VERIFIED_MARKER))
  return (
    `if [ -f ${verified} ] && [ -x ${executable} ]; ` +
    `then echo ${REMOTE_NODE_RUNTIME_READY}; else echo ${REMOTE_NODE_RUNTIME_MISSING}; fi`
  )
}

/**
 * Extract, verify, self-test and publish. The executable is renamed into place file-by-file,
 * so a concurrent installer of the same pin only ever replaces identical verified bytes.
 */
export function promoteRemoteNodeRuntimeCommand(
  host: RemoteHostPlatform,
  args: {
    stageDir: string
    archive: string
    runtimeDir: string
    target: NodeRuntimeTarget
    token: string
  }
): string {
  assertPosixOrcadHost(host)
  const asset = pinnedNodeRuntimeAsset(args.target)
  const member = nodeRuntimeExecutablePath(args.target, asset.archive)
  const stage = shellEscape(args.stageDir)
  const extracted = shellEscape(joinRemotePath(host, args.stageDir, ...member.split('/')))
  const binDir = shellEscape(joinRemotePath(host, args.runtimeDir, 'bin'))
  const temporary = shellEscape(joinRemotePath(host, args.runtimeDir, 'bin', `node.${args.token}`))
  const executable = shellEscape(posixNodeRuntimeExecutable(host, args.runtimeDir))
  const verified = shellEscape(joinRemotePath(host, args.runtimeDir, VERIFIED_MARKER))
  return [
    `cd ${stage} || exit 1`,
    `tar -xzf ${shellEscape(joinRemotePath(host, args.stageDir, args.archive))} ${shellEscape(member)} || { echo ORCA_NODE_RUNTIME_EXTRACT_FAILED; exit 1; }`,
    `[ "$(${sha256Of(extracted)})" = ${shellEscape(asset.executableSha256)} ] || { echo ORCA_NODE_RUNTIME_HASH_MISMATCH; exit 1; }`,
    `chmod 755 ${extracted}`,
    // Why run it: executing is the only reliable check for noexec mounts and a wrong libc.
    // Exit 0 on refusal so the caller receives the loader's words to classify, not a bare exit 1.
    `{ orca_rt_out=$(${extracted} --version 2>&1); orca_rt_status=$?; ` +
      `[ "$orca_rt_out" = ${shellEscape(`v${NODE_RUNTIME_PIN.version}`)} ] || ` +
      `{ echo ${REMOTE_NODE_RUNTIME_SELFTEST_FAILED}; echo "${REMOTE_NODE_RUNTIME_EXIT_PREFIX}$orca_rt_status"; ` +
      `printf '%s\\n' "$orca_rt_out" | head -c 4000; exit 0; }; }`,
    `mkdir -p ${binDir}`,
    `mv -f ${extracted} ${temporary}`,
    `mv -f ${temporary} ${executable}`,
    `: > ${verified}`,
    `echo ${REMOTE_NODE_RUNTIME_READY}`
  ].join(' && ')
}

/**
 * Copies the archive at `$1` (a path the host can already read, e.g. a WSL view of the
 * client's cache) into a fresh stage, promotes it, and removes the stage whatever happens.
 */
export function installNodeRuntimeFromHostArchiveCommand(
  host: RemoteHostPlatform,
  args: { runtimeDir: string; archive: string; target: NodeRuntimeTarget; token: string }
): string {
  const stageDir = nodeRuntimeStageDir(host, args.runtimeDir, args.token)
  const stage = shellEscape(stageDir)
  const promote = promoteRemoteNodeRuntimeCommand(host, { ...args, stageDir })
  const copy = `cp -- "$1" ${shellEscape(joinRemotePath(host, stageDir, args.archive))}`
  // Subshell: promote's `exit 1` must still reach the stage cleanup.
  return `(umask 077 && mkdir -p ${stage} && ${copy} && ${promote}); status=$?; rm -rf ${stage}; exit $status`
}

export type RemoteRuntimeStep = <T>(operation: () => Promise<T>) => Promise<T>

const runDirectly: RemoteRuntimeStep = (operation) => operation()

export type EnsuredRemoteNodeRuntime = {
  executable: string
  transfer: 'cached' | 'uploaded'
}

/**
 * Ensures the runtime beside `slotDir` exists on the host, uploading the pinned archive only
 * when needed, and returns its executable and whether this call uploaded it.
 */
export async function ensureRemoteOrcadNodeRuntime(options: {
  conn: SshConnection
  host: RemoteHostPlatform
  slotDir: string
  target: NodeRuntimeTarget
  /** The locally verified pinned archive (pinned-runtime-materializer). */
  archivePath: () => Promise<string>
  signal?: AbortSignal
  /** Wraps each host round trip, so a caller can tell an unconfirmed channel from a local failure. */
  remoteStep?: RemoteRuntimeStep
}): Promise<EnsuredRemoteNodeRuntime> {
  const { conn, host, target, signal } = options
  const remoteStep = options.remoteStep ?? runDirectly
  const windows = isWindowsRemoteHost(host)
  // Why unwrapped on Windows: these are already self-contained powershell.exe command lines.
  const exec = (command: string, execOptions: { signal?: AbortSignal; timeoutMs?: number } = {}) =>
    remoteStep(() => execCommand(conn, command, { ...execOptions, wrapCommand: !windows }))
  const runtimeDir = remoteNodeRuntimeDir(host, options.slotDir, target)
  const executable = joinRemotePath(
    host,
    runtimeDir,
    ...orcadNodeRuntimeExecutable(target).split('/')
  )
  const token = randomBytes(8).toString('hex')
  const stageDir = nodeRuntimeStageDir(host, runtimeDir, token)
  // Why the stage rides the probe on Windows: every exec there is a powershell.exe spawn.
  const probe = await exec(
    windows
      ? windowsNodeRuntimeProbeCommand(runtimeDir, target, stageDir)
      : probeRemoteNodeRuntimeCommand(host, runtimeDir, target),
    { signal }
  )
  if (probe.trim() === REMOTE_NODE_RUNTIME_READY) {
    return { executable, transfer: 'cached' }
  }
  const cleanupStage = windows
    ? windowsNodeRuntimeStageCleanupCommand(stageDir)
    : `rm -rf ${shellEscape(stageDir)}`
  let localStage: string | undefined
  let stageUnconfirmed = false
  let hostRemovedStage = false
  try {
    const archivePath = await options.archivePath()
    const uploadDir = await mkdtemp(join(dirname(archivePath), '.runtime-upload-'))
    localStage = uploadDir
    const archive = basename(archivePath)
    await link(archivePath, join(uploadDir, archive)).catch(() =>
      copyFile(archivePath, join(uploadDir, archive))
    )
    if (!windows) {
      await exec(`mkdir -p ${shellEscape(stageDir)}`, { signal })
    }
    await remoteStep(() => uploadRelayDirectory(conn, uploadDir, stageDir, host, { signal }))
    let promoteRan = false
    // Why unwrapped on Windows: these are already self-contained powershell.exe command lines.
    const runLocked = (command: string, timeoutMs?: number): Promise<string> =>
      execCommand(conn, command, { signal, timeoutMs, wrapCommand: !windows })
    const promote = (): Promise<string> => {
      promoteRan = true
      return windows
        ? runLocked(
            windowsNodeRuntimePromoteCommand({ stageDir, archive, runtimeDir, target }),
            WINDOWS_NODE_RUNTIME_PROMOTE_TIMEOUT_MS
          )
        : runLocked(
            promoteRemoteNodeRuntimeCommand(host, { stageDir, archive, runtimeDir, target, token })
          )
    }
    // Why the lock on Windows too: store GC collects there as well (design D5).
    const promoted = await remoteStep(() =>
      withRuntimeStoreLock(
        conn,
        host,
        remoteDirname(runtimeDir, host),
        // Why re-probe under the lock: a sibling installer may have published this pin while we uploaded.
        async () =>
          (await runLocked(probeRemoteNodeRuntimeCommand(host, runtimeDir, target))).trim() ===
          REMOTE_NODE_RUNTIME_READY
            ? REMOTE_NODE_RUNTIME_READY
            : promote(),
        signal
      )
    )
    // Why: the Windows promote script removes its stage on every path; skip a second powershell.exe.
    hostRemovedStage = windows && promoteRan
    assertRemoteNodeRuntimePromoted(promoted)
    return { executable, transfer: 'uploaded' }
  } catch (error) {
    stageUnconfirmed = isUnconfirmedSshCommandTermination(error)
    throw error
  } finally {
    if (localStage) {
      await rm(localStage, { recursive: true, force: true }).catch(() => {})
    }
    // A transfer that may still be writing keeps its stage; loss of contact is not an exit.
    if (!stageUnconfirmed && !hostRemovedStage) {
      await exec(cleanupStage).catch(() => {})
    }
  }
}

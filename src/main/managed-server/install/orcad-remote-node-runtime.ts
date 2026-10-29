// Orcad slots and vault readers share the content-addressed Node store and its GC lock.
import { randomBytes } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { basename } from 'node:path'
import {
  pinnedNodeRuntimeAsset,
  NODE_RUNTIME_PIN,
  nodeRuntimeExecutablePath,
  type NodeRuntimeTarget
} from '../../../shared/node-runtime-pin'
import {
  ORCAD_NODE_RUNTIME_DIR_PREFIX,
  ORCAD_NODE_RUNTIME_POSIX_EXECUTABLE,
  ORCAD_RUNTIMES_DIRNAME,
  orcadNodeRuntimeExecutable
} from '../../../shared/orcad-artifacts'
import type { OrcadHostTransport } from '../../ssh/orcad-host-transport'
import { quotePosixShell } from '../../../shared/shell-argument-quoting'
import {
  execCommand,
  isUnconfirmedSshCommandTermination
} from '../../ssh/remote-exec/remote-exec-command'
import { uploadRemoteInstallDirectory } from './remote-install-transfers'
import { remoteSha256Command } from './remote-sha256-command'
import { stageNodeRuntimeArchive } from './remote-node-runtime-host-download'
import {
  isWindowsRemoteHost,
  joinRemotePath,
  remoteDirname,
  type RemoteHostPlatform
} from '../../ssh/ssh-remote-platform'
import { assertPosixOrcadHost } from './orcad-remote-host-support'
import { withRuntimeStoreLock, type HeldRuntimeStoreLock } from './remote-node-runtime-store-lock'
import {
  assertRemoteNodeRuntimePromoted,
  assertRemoteNodeRuntimeStoreExecutable,
  assertWindowsHostCanInstallNodeRuntime,
  REMOTE_NODE_RUNTIME_EXIT_PREFIX,
  REMOTE_NODE_RUNTIME_NOEXEC,
  REMOTE_NODE_RUNTIME_MISSING,
  REMOTE_NODE_RUNTIME_READY,
  REMOTE_NODE_RUNTIME_SELFTEST_FAILED,
  REMOTE_NODE_RUNTIME_VERIFIED_MARKER
} from '../../ssh/orcad-remote-node-runtime-report'
import {
  windowsNodeRuntimePresentCommand,
  windowsNodeRuntimeProbeCommand,
  windowsNodeRuntimePromoteCommand,
  windowsNodeRuntimeStageCleanupCommand
} from './orcad-remote-node-runtime-windows'

const VERIFIED_MARKER = REMOTE_NODE_RUNTIME_VERIFIED_MARKER
// Slow storage and Windows Expand-Archive can take minutes to hash, extract and self-test.
export const NODE_RUNTIME_PROMOTE_TIMEOUT_MS = 300_000
export const RUNTIME_STORE_STAGE_PREFIX = '.stage-'

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

export function remoteNodeRuntimeDir(
  host: RemoteHostPlatform,
  slotDir: string,
  target: NodeRuntimeTarget
): string {
  return nodeRuntimeStoreDir(host, remoteDirname(slotDir.replace(/\/+$/, ''), host), target)
}

export function posixNodeRuntimeExecutable(host: RemoteHostPlatform, runtimeDir: string): string {
  return joinRemotePath(host, runtimeDir, ...ORCAD_NODE_RUNTIME_POSIX_EXECUTABLE.split('/'))
}

// Dot-prefixed stages stay out of node-* listings.
function nodeRuntimeStageDir(host: RemoteHostPlatform, runtimeDir: string, token: string): string {
  return joinRemotePath(
    host,
    remoteDirname(runtimeDir, host),
    `${RUNTIME_STORE_STAGE_PREFIX}${basename(runtimeDir)}-${token}`
  )
}

/** Detect noexec stores before downloading or uploading the archive. */
export function createExecProbedStageCommand(host: RemoteHostPlatform, stageDir: string): string {
  const stage = quotePosixShell(stageDir)
  const probe = quotePosixShell(joinRemotePath(host, stageDir, '.exec-probe'))
  return (
    // Upload diagnoses full disks if this probe cannot be written.
    `mkdir -p ${stage} && { if printf '#!/bin/sh\\necho ok\\n' > ${probe} 2>/dev/null && chmod 700 ${probe}; then ` +
    `orca_x=$(${probe} 2>&1); orca_x_status=$?; rm -f ${probe}; ` +
    `[ "$orca_x_status" = 0 ] || { echo ${REMOTE_NODE_RUNTIME_NOEXEC}; ` +
    `echo "${REMOTE_NODE_RUNTIME_EXIT_PREFIX}$orca_x_status"; printf '%s\\n' "$orca_x" | head -c 2000; }; ` +
    `else rm -f ${probe}; fi; }`
  )
}

export function probeRemoteNodeRuntimeCommand(
  host: RemoteHostPlatform,
  runtimeDir: string,
  target: NodeRuntimeTarget
): string {
  if (isWindowsRemoteHost(host)) {
    return windowsNodeRuntimeProbeCommand(runtimeDir, target)
  }
  const executable = quotePosixShell(posixNodeRuntimeExecutable(host, runtimeDir))
  const verified = quotePosixShell(joinRemotePath(host, runtimeDir, VERIFIED_MARKER))
  return (
    `if [ -f ${verified} ] && [ -x ${executable} ] && ` +
    `[ "$(${remoteSha256Command(executable)})" = ${quotePosixShell(pinnedNodeRuntimeAsset(target).executableSha256)} ]; ` +
    `then echo ${REMOTE_NODE_RUNTIME_READY}; else echo ${REMOTE_NODE_RUNTIME_MISSING}; fi`
  )
}

/** Warm checks skip hashing; run also detects execution-policy or library changes. */
export function remoteNodeRuntimePresentCommand(
  host: RemoteHostPlatform,
  runtimeDir: string,
  run = false
): string {
  if (isWindowsRemoteHost(host)) {
    return windowsNodeRuntimePresentCommand(runtimeDir, run)
  }
  const executable = quotePosixShell(
    joinRemotePath(host, runtimeDir, ...ORCAD_NODE_RUNTIME_POSIX_EXECUTABLE.split('/'))
  )
  const verified = quotePosixShell(joinRemotePath(host, runtimeDir, VERIFIED_MARKER))
  const ready = run
    ? `{ orca_rt_out=$(${executable} --version 2>&1); orca_rt_status=$?; ` +
      `if [ "$orca_rt_out" = ${quotePosixShell(`v${NODE_RUNTIME_PIN.version}`)} ]; then echo ${REMOTE_NODE_RUNTIME_READY}; ` +
      `else echo ${REMOTE_NODE_RUNTIME_SELFTEST_FAILED}; echo "${REMOTE_NODE_RUNTIME_EXIT_PREFIX}$orca_rt_status"; ` +
      `printf '%s\\n' "$orca_rt_out" | head -c 4000; fi; }`
    : `echo ${REMOTE_NODE_RUNTIME_READY}`
  return (
    `if [ -f ${verified} ] && [ -x ${executable} ]; ` +
    `then ${ready}; else echo ${REMOTE_NODE_RUNTIME_MISSING}; fi`
  )
}

/** File-by-file publication permits concurrent installers to replace only identical verified bytes. */
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
  const stage = quotePosixShell(args.stageDir)
  const extracted = quotePosixShell(joinRemotePath(host, args.stageDir, ...member.split('/')))
  const binDir = quotePosixShell(joinRemotePath(host, args.runtimeDir, 'bin'))
  const temporary = quotePosixShell(
    joinRemotePath(host, args.runtimeDir, 'bin', `node.${args.token}`)
  )
  const executable = quotePosixShell(posixNodeRuntimeExecutable(host, args.runtimeDir))
  const verified = quotePosixShell(joinRemotePath(host, args.runtimeDir, VERIFIED_MARKER))
  return [
    `cd ${stage} || exit 1`,
    `tar -xzf ${quotePosixShell(joinRemotePath(host, args.stageDir, args.archive))} ${quotePosixShell(member)} || { echo ORCA_NODE_RUNTIME_EXTRACT_FAILED; exit 1; }`,
    `[ "$(${remoteSha256Command(extracted)})" = ${quotePosixShell(asset.executableSha256)} ] || { echo ORCA_NODE_RUNTIME_HASH_MISMATCH; exit 1; }`,
    `chmod 755 ${extracted}`,
    // Execution detects noexec/libc failures; exit 0 preserves loader diagnostics for classification.
    `{ orca_rt_out=$(${extracted} --version 2>&1); orca_rt_status=$?; ` +
      `[ "$orca_rt_out" = ${quotePosixShell(`v${NODE_RUNTIME_PIN.version}`)} ] || ` +
      `{ echo ${REMOTE_NODE_RUNTIME_SELFTEST_FAILED}; echo "${REMOTE_NODE_RUNTIME_EXIT_PREFIX}$orca_rt_status"; ` +
      `printf '%s\\n' "$orca_rt_out" | head -c 4000; exit 0; }; }`,
    `mkdir -p ${binDir}`,
    `mv -f ${extracted} ${temporary}`,
    `mv -f ${temporary} ${executable}`,
    `: > ${verified}`,
    `echo ${REMOTE_NODE_RUNTIME_READY}`
  ].join(' && ')
}

/** Keep rechecking and promotion in one command covered by the host lock release. */
export function recheckAndPromoteRemoteNodeRuntimeCommand(
  host: RemoteHostPlatform,
  args: Parameters<typeof promoteRemoteNodeRuntimeCommand>[1]
): string {
  const probe = probeRemoteNodeRuntimeCommand(host, args.runtimeDir, args.target)
  return (
    `if [ "$(${probe})" = ${REMOTE_NODE_RUNTIME_READY} ]; then echo ${REMOTE_NODE_RUNTIME_READY}; ` +
    `else ${promoteRemoteNodeRuntimeCommand(host, args)}; fi`
  )
}

/** Promote a host-readable archive and clean up its stage even on failure. */
export function installNodeRuntimeFromHostArchiveCommand(
  host: RemoteHostPlatform,
  args: { runtimeDir: string; archive: string; target: NodeRuntimeTarget; token: string }
): string {
  const stageDir = nodeRuntimeStageDir(host, args.runtimeDir, args.token)
  const stage = quotePosixShell(stageDir)
  const promote = promoteRemoteNodeRuntimeCommand(host, { ...args, stageDir })
  const copy = `cp -- "$1" ${quotePosixShell(joinRemotePath(host, stageDir, args.archive))}`
  // Subshell: promote's `exit 1` must still reach the stage cleanup.
  return `(umask 077 && mkdir -p ${stage} && ${copy} && ${promote}); status=$?; rm -rf ${stage}; exit $status`
}

type RemoteRuntimeStep = <T>(operation: () => Promise<T>) => Promise<T>

const runDirectly: RemoteRuntimeStep = (operation) => operation()

type EnsuredRemoteNodeRuntime = {
  executable: string
  transfer: 'cached' | 'uploaded' | 'host-downloaded'
}

export async function ensureRemoteOrcadNodeRuntime(options: {
  conn: OrcadHostTransport
  host: RemoteHostPlatform
  slotDir: string
  target: NodeRuntimeTarget
  archivePath: () => Promise<string>
  /** Name the offline archive location when every download fails. */
  offlineArchivePath?: string
  signal?: AbortSignal
  /** Distinguish unconfirmed host round trips from local failures. */
  remoteStep?: RemoteRuntimeStep
  /** Override the first POSIX probe; the under-lock recheck still hashes. */
  posixProbeCommand?: typeof probeRemoteNodeRuntimeCommand
}): Promise<EnsuredRemoteNodeRuntime> {
  const { conn, host, target, signal } = options
  const remoteStep = options.remoteStep ?? runDirectly
  const windows = isWindowsRemoteHost(host)
  // Windows commands already include powershell.exe.
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
  // Stage during the Windows probe to avoid another powershell.exe spawn.
  const probe = await exec(
    windows
      ? windowsNodeRuntimeProbeCommand(runtimeDir, target, stageDir)
      : (options.posixProbeCommand ?? probeRemoteNodeRuntimeCommand)(host, runtimeDir, target),
    { signal, timeoutMs: NODE_RUNTIME_PROMOTE_TIMEOUT_MS }
  )
  if (probe.trim() === REMOTE_NODE_RUNTIME_READY) {
    return { executable, transfer: 'cached' }
  }
  if (windows) {
    assertWindowsHostCanInstallNodeRuntime(probe)
  }
  const cleanupStage = windows
    ? windowsNodeRuntimeStageCleanupCommand(stageDir)
    : `rm -rf ${quotePosixShell(stageDir)}`
  let localStage: string | undefined
  let stageUnconfirmed = false
  let hostRemovedStage = false
  try {
    // Reject noexec stores before archive acquisition can trigger a download.
    if (!windows) {
      assertRemoteNodeRuntimeStoreExecutable(
        await exec(createExecProbedStageCommand(host, stageDir), { signal }),
        remoteDirname(runtimeDir, host)
      )
    }
    const { archive } = await stageNodeRuntimeArchive({
      ...options,
      exec,
      stageDir,
      upload: (dir) =>
        remoteStep(() => uploadRemoteInstallDirectory(conn, dir, stageDir, host, { signal })),
      onLocalStage: (dir) => (localStage = dir)
    })
    let promoteRan = false
    const runLocked = (command: string): Promise<string> =>
      execCommand(conn, command, {
        signal,
        timeoutMs: NODE_RUNTIME_PROMOTE_TIMEOUT_MS,
        wrapCommand: !windows
      })
    // A sibling may have published this pin during our upload.
    const recheckAndPromote = async (held: HeldRuntimeStoreLock): Promise<string> => {
      if (!windows) {
        return runLocked(
          held.releasedByHostOnExit(
            recheckAndPromoteRemoteNodeRuntimeCommand(host, {
              stageDir,
              archive,
              runtimeDir,
              target,
              token
            })
          )
        )
      }
      if (
        (await runLocked(probeRemoteNodeRuntimeCommand(host, runtimeDir, target))).trim() ===
        REMOTE_NODE_RUNTIME_READY
      ) {
        return REMOTE_NODE_RUNTIME_READY
      }
      promoteRan = true
      return runLocked(windowsNodeRuntimePromoteCommand({ stageDir, archive, runtimeDir, target }))
    }
    const promoted = await remoteStep(() =>
      withRuntimeStoreLock(conn, host, remoteDirname(runtimeDir, host), recheckAndPromote, signal)
    )
    // Windows promotion removes its stage; avoid another powershell.exe spawn.
    hostRemovedStage = windows && promoteRan
    assertRemoteNodeRuntimePromoted(promoted)
    return { executable, transfer: localStage ? 'uploaded' : 'host-downloaded' }
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

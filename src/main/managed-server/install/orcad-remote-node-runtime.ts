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
import { uploadRelayDirectory } from './remote-install-transfers'
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
/**
 * Any step that reads the whole ~110 MiB executable (probe hash, extract, self-test) takes minutes
 * on slow storage (HH-3), and Windows may fall back to Expand-Archive.
 */
export const NODE_RUNTIME_PROMOTE_TIMEOUT_MS = 300_000
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

/**
 * Creates the stage and runs a two-line script from it, so a store that can't run programs (a
 * `noexec` home) is named before the ~40 MiB upload instead of failing the self-test after it.
 */
export function createExecProbedStageCommand(host: RemoteHostPlatform, stageDir: string): string {
  const stage = quotePosixShell(stageDir)
  const probe = quotePosixShell(joinRemotePath(host, stageDir, '.exec-probe'))
  return (
    // Why the probe write may fail quietly: a full disk is diagnosed by the upload that follows.
    `mkdir -p ${stage} && { if printf '#!/bin/sh\\necho ok\\n' > ${probe} 2>/dev/null && chmod 700 ${probe}; then ` +
    `orca_x=$(${probe} 2>&1); orca_x_status=$?; rm -f ${probe}; ` +
    `[ "$orca_x_status" = 0 ] || { echo ${REMOTE_NODE_RUNTIME_NOEXEC}; ` +
    `echo "${REMOTE_NODE_RUNTIME_EXIT_PREFIX}$orca_x_status"; printf '%s\\n' "$orca_x" | head -c 2000; }; ` +
    `else rm -f ${probe}; fi; }`
  )
}

// Why both tools: GNU/busybox ship sha256sum, macOS ships shasum; either prints the digest first.
export function remoteSha256Command(path: string): string {
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
  const executable = quotePosixShell(posixNodeRuntimeExecutable(host, runtimeDir))
  const verified = quotePosixShell(joinRemotePath(host, runtimeDir, VERIFIED_MARKER))
  return (
    `if [ -f ${verified} ] && [ -x ${executable} ] && ` +
    `[ "$(${remoteSha256Command(executable)})" = ${quotePosixShell(pinnedNodeRuntimeAsset(target).executableSha256)} ]; ` +
    `then echo ${REMOTE_NODE_RUNTIME_READY}; else echo ${REMOTE_NODE_RUNTIME_MISSING}; fi`
  )
}

/** Cheap warm-path check: a published runtime has its marker and an executable; no re-hash. */
/**
 * READY when the verified runtime is in place. With `run`, the same command also runs it and
 * reports a refusal the way promotion does, so a host whose exec policy or libraries changed since
 * the install is caught before a launch, at no extra round trip.
 */
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
    // Why run it: executing is the only reliable check for noexec mounts and a wrong libc.
    // Exit 0 on refusal so the caller receives the loader's words to classify, not a bare exit 1.
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

/**
 * The under-lock step as one host command: publish unless a sibling already did while this client
 * uploaded. One command, so the host's lock release covers the re-hash as well as the promote.
 */
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

/**
 * Copies the archive at `$1` (a path the host can already read, e.g. a WSL view of the
 * client's cache) into a fresh stage, promotes it, and removes the stage whatever happens.
 */
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
  conn: OrcadHostTransport
  host: RemoteHostPlatform
  slotDir: string
  target: NodeRuntimeTarget
  /** The locally verified pinned archive (pinned-runtime-materializer). */
  archivePath: () => Promise<string>
  signal?: AbortSignal
  /** Wraps each host round trip, so a caller can tell an unconfirmed channel from a local failure. */
  remoteStep?: RemoteRuntimeStep
  /** Replaces the POSIX first probe only; the under-lock recheck always hashes. */
  posixProbeCommand?: typeof probeRemoteNodeRuntimeCommand
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
      : (options.posixProbeCommand ?? probeRemoteNodeRuntimeCommand)(host, runtimeDir, target),
    { signal, timeoutMs: NODE_RUNTIME_PROMOTE_TIMEOUT_MS }
  )
  if (probe.trim() === REMOTE_NODE_RUNTIME_READY) {
    return { executable, transfer: 'cached' }
  }
  const cleanupStage = windows
    ? windowsNodeRuntimeStageCleanupCommand(stageDir)
    : `rm -rf ${quotePosixShell(stageDir)}`
  let localStage: string | undefined
  let stageUnconfirmed = false
  let hostRemovedStage = false
  try {
    // Why before the archive: fetching it may download, and a noexec store would waste both.
    if (!windows) {
      assertRemoteNodeRuntimeStoreExecutable(
        await exec(createExecProbedStageCommand(host, stageDir), { signal }),
        remoteDirname(runtimeDir, host)
      )
    }
    const archivePath = await options.archivePath()
    const uploadDir = await mkdtemp(join(dirname(archivePath), '.runtime-upload-'))
    localStage = uploadDir
    const archive = basename(archivePath)
    await link(archivePath, join(uploadDir, archive)).catch(() =>
      copyFile(archivePath, join(uploadDir, archive))
    )
    await remoteStep(() => uploadRelayDirectory(conn, uploadDir, stageDir, host, { signal }))
    let promoteRan = false
    // Why unwrapped on Windows: these are already self-contained powershell.exe command lines.
    const runLocked = (command: string): Promise<string> =>
      execCommand(conn, command, {
        signal,
        timeoutMs: NODE_RUNTIME_PROMOTE_TIMEOUT_MS,
        wrapCommand: !windows
      })
    // Why re-probe under the lock: a sibling installer may have published this pin while we uploaded.
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
    // Why the lock on Windows too: store GC collects there as well (design D5).
    const promoted = await remoteStep(() =>
      withRuntimeStoreLock(conn, host, remoteDirname(runtimeDir, host), recheckAndPromote, signal)
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

/**
 * Prove `node-pty` can be loaded on this host BEFORE anything in the process requires it.
 *
 * Why this exists: of the two ways node-pty fails, only one is catchable. A missing
 * module throws `MODULE_NOT_FOUND` and a caller can degrade. A module that is present but
 * built against the wrong libc or Node ABI is refused by the dynamic loader, and in the
 * worst case takes the process down before any handler exists — that is #9902, which
 * crashed the desktop app on Ubuntu 20.04 before a window appeared
 * (docs/reference/linux-glibc-compatibility.md).
 *
 * So the load happens in a CHILD process. Whatever the child does — throw, abort, die on
 * a signal — is data to us rather than our own death, and the operator gets a sentence
 * naming what to change instead of a loader stack trace.
 *
 * The cost is one short-lived `node -e` at startup. That is the price of turning an
 * uncatchable failure into a catchable one, and it is paid once per boot.
 */
import { existsSync, accessSync, constants } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { runProcessSync, type ProcessResult } from '../../shared/child-process/run-process'
import { usesNodePtySpawnHelper } from '../../shared/node-pty-spawn-helper'
import type { RuntimeTerminalUnavailableReason } from '../../shared/runtime-types'
import {
  buildToolchainProbeCommand,
  parseBuildToolchainProbe,
  toolchainInstallHintLines
} from '../ssh/build-toolchain-diagnosis'
import { detectNativeHostAbi, nativeSlotName, type NativeHostAbi } from './native-host-abi'
import { classifyNodePtyLoaderMessage, firstErrorLine } from './node-pty-loader-diagnosis'
import { installPrebuiltSlot, type PrebuiltSlotOutcome } from './node-pty-prebuilt-slot'

// Why every verdict travels on STDOUT: node echoes the whole `-e` source into stderr
// before the stack trace, so any substring test against stderr also matches this file's
// own token strings. stdout carries only what the child chose to print.
const PROBE_OK_TOKEN = 'ORCA_NODE_PTY_LOAD_OK'
const NO_BINARY_TOKEN = 'ORCA_NODE_PTY_NO_BINARY'
const LOAD_ERROR_TOKEN = 'ORCA_NODE_PTY_LOAD_ERROR'
const PROBE_TIMEOUT_MS = 20_000

/**
 * `ok` — proved loadable. `degraded` — loads, but something only spawn-time needs is
 * broken, so the host should still serve everything else. `blocked` — proved unloadable,
 * so nothing in this process may require it. `unverifiable` — the probe itself did not
 * answer, which is not evidence either way.
 *
 * Why `unverifiable` is separate from `blocked`: a probe that times out or cannot spawn
 * says nothing about node-pty, and refusing to boot on it would brick working hosts for
 * a reason that was never established. Same verdict discipline as
 * docs/reference/ssh-execution-boundary.md — loss of contact is not proof of death.
 */
export type NodePtyPreconditionStatus = 'ok' | 'degraded' | 'blocked' | 'unverifiable'

export type NodePtyPreconditionVerdict = {
  status: NodePtyPreconditionStatus
  slot: string
  abi: NativeHostAbi
  reason?: RuntimeTerminalUnavailableReason
  detail?: string
  /** What the slot install did, when one was attempted. */
  prebuilt?: PrebuiltSlotOutcome
}

export type NodePtyProbeFailure = {
  status: 'blocked' | 'unverifiable'
  reason: RuntimeTerminalUnavailableReason
  detail: string
}

/**
 * What the child actually reported, before any judgement is made about it.
 *
 * Split from the classification so callers that need the loader's own words — the relay,
 * which quotes them back when nothing recognizes the shape — do not have to re-derive
 * them from a formatted verdict.
 */
export type NodePtyProbeOutcome =
  | { kind: 'loaded'; loadedDir: string | null }
  | { kind: 'noBinary' }
  | { kind: 'loaderError'; message: string }
  | { kind: 'signalled'; signal: NodeJS.Signals }
  /** The probe never answered. Not evidence about node-pty either way. */
  | { kind: 'unanswered'; detail: string }
  /** It answered, but with nothing that names a cause. */
  | { kind: 'unexplained'; detail: string }

export function readNodePtyProbeOutcome(
  result: Pick<ProcessResult, 'code' | 'signal' | 'stdout' | 'stderr' | 'timedOut'>
): NodePtyProbeOutcome {
  const stdout = result.stdout
  if (result.code === 0 && stdout.includes(PROBE_OK_TOKEN)) {
    return {
      kind: 'loaded',
      loadedDir: stdout.split(PROBE_OK_TOKEN)[1]?.trim().split('\n')[0]?.trim() || null
    }
  }
  if (result.timedOut) {
    return {
      kind: 'unanswered',
      detail: 'the node-pty load probe did not finish in time, so nothing was established'
    }
  }
  // Why signal before anything the child said: a binary that aborts or segfaults inside
  // the loader never reaches the catch, and often prints nothing at all. That silence is
  // exactly the uncatchable case this probe is a separate process for.
  if (result.signal) {
    return { kind: 'signalled', signal: result.signal }
  }
  if (stdout.includes(NO_BINARY_TOKEN)) {
    return { kind: 'noBinary' }
  }
  const reported = readReportedLoadError(stdout)
  if (reported !== null) {
    return { kind: 'loaderError', message: reported }
  }
  return {
    kind: 'unexplained',
    detail: firstErrorLine(result.stderr) || `the load probe exited with code ${result.code}`
  }
}

/**
 * Read the child's exit into a cause. Pure, so every failure shape is testable from a
 * host that cannot reproduce it — the whole point, since the shapes that matter belong
 * to Alpine and Ubuntu 20.04.
 */
export function classifyNodePtyProbeResult(
  result: Pick<ProcessResult, 'code' | 'signal' | 'stdout' | 'stderr' | 'timedOut'>
): NodePtyProbeFailure | null {
  const outcome = readNodePtyProbeOutcome(result)
  switch (outcome.kind) {
    case 'loaded':
      return null
    case 'unanswered':
      return { status: 'unverifiable', reason: 'unknown', detail: outcome.detail }
    case 'signalled':
      return {
        status: 'blocked',
        reason: 'load_crashed',
        detail: `the load probe was killed by ${outcome.signal}`
      }
    case 'noBinary':
      return {
        status: 'blocked',
        reason: 'dependency_missing',
        detail: 'node-pty is installed but has no compiled binary for this platform'
      }
    case 'loaderError':
      return classifyLoaderMessage(outcome.message)
    case 'unexplained':
      return { status: 'blocked', reason: 'load_failed', detail: outcome.detail }
  }
}

/** The message the child caught, or null when it never got that far. */
function readReportedLoadError(stdout: string): string | null {
  const line = stdout.split('\n').find((candidate) => candidate.startsWith(LOAD_ERROR_TOKEN))
  if (!line) {
    return null
  }
  try {
    return JSON.parse(line.slice(LOAD_ERROR_TOKEN.length).trim()) as string
  } catch {
    return line.slice(LOAD_ERROR_TOKEN.length).trim()
  }
}

/** Read a dynamic-loader message. Pure, so shapes this host cannot reproduce are testable. */
export function classifyLoaderMessage(message: string): NodePtyProbeFailure {
  return { status: 'blocked', ...classifyNodePtyLoaderMessage(message) }
}

/**
 * The script the child runs.
 *
 * Why it dlopens the file itself rather than trusting node-pty's loader: that loader
 * tries several directories and rethrows only the LAST error, so a `pty.node` the
 * dynamic loader refused is reported as `Cannot find module './prebuilds/...'`. Acting on
 * that sends the operator to install a module that is already there. The dlopen has to
 * come BEFORE `require(index.js)` for the same reason: node-pty's unixTerminal calls the
 * loader at module scope, so requiring the package first re-wraps the error we came for.
 *
 * Why it catches and prints instead of throwing: a thrown error reaches us as a stack
 * trace with the script source echoed above it, and the message we need is then one line
 * inside a blob that also contains these very tokens. What the child cannot catch — a
 * loader that aborts the process — still reaches us as a signal, which is the case this
 * whole indirection exists for.
 */
export function buildNodePtyLoadProbeScript(nodePtyDir: string): string {
  const entry = JSON.stringify(join(nodePtyDir, 'lib', 'index.js'))
  const utils = JSON.stringify(join(nodePtyDir, 'lib', 'utils.js'))
  const root = JSON.stringify(nodePtyDir)
  // Same directory order node-pty's own loader walks, so the file opened here is the file
  // it would load. Windows defers conpty.node to the first spawn, which is why the name is
  // chosen the way node-pty chooses it rather than always being 'pty'.
  return [
    `const fs=require('fs'),p=require('path');`,
    `const n=process.platform==='win32'&&Number(require('os').release().split('.')[2])>=18309?'conpty':'pty';`,
    `let f=null;`,
    `for(const d of ['build/Release','build/Debug','prebuilds/'+process.platform+'-'+process.arch]){`,
    `for(const r of [${root},p.join(${root},'lib')]){`,
    `const c=p.join(r,d,n+'.node');if(fs.existsSync(c)){f=c;break}}if(f)break}`,
    `if(!f){console.log(${JSON.stringify(NO_BINARY_TOKEN)});process.exit(3)}`,
    `try{`,
    `process.dlopen({exports:{}},f);`,
    `require(${entry});`,
    `require(${utils}).loadNativeModule(n);`,
    `console.log(${JSON.stringify(PROBE_OK_TOKEN)}+' '+p.dirname(f));`,
    `}catch(e){`,
    `console.log(${JSON.stringify(LOAD_ERROR_TOKEN)}+' '+JSON.stringify(String((e&&e.message)||e)));`,
    `process.exit(4)}`
  ].join('')
}

function resolveNodePtyDir(): string | null {
  try {
    // Why require.resolve and not import: resolution only — the load itself happens in
    // the child process, which is the whole point of the precondition.
    return dirname(require.resolve('node-pty/package.json'))
  } catch {
    return null
  }
}

/** Local equivalent of the relay's remote toolchain probe, reusing its pure half. */
export function probeLocalBuildToolchainHints(platform: NodeJS.Platform): string[] {
  if (platform === 'win32') {
    return []
  }
  // Why macOS is not routed through the relay's hints: that function answers with a
  // cross-distro apt/dnf/pacman/apk menu when it finds no package manager, and none of
  // those lines is the macOS answer. Printing them here would be confidently wrong.
  if (platform === 'darwin') {
    return ['  xcode-select --install']
  }
  try {
    const result = runProcessSync({
      program: '/bin/sh',
      args: ['-c', buildToolchainProbeCommand()],
      timeoutMs: 10_000
    })
    return toolchainInstallHintLines(parseBuildToolchainProbe(result.stdout))
  } catch {
    return []
  }
}

export function checkNodePtyPrecondition(
  options: { nodePtyDir?: string | null; abi?: NativeHostAbi; prebuildsDir?: string | null } = {}
): NodePtyPreconditionVerdict {
  const abi = options.abi ?? detectNativeHostAbi()
  const slot = nativeSlotName(abi)
  // Why `in` and not `??`: an explicit `null` means "this host cannot resolve node-pty",
  // which is a case tests must be able to state. `??` would silently re-detect instead.
  const nodePtyDir = 'nodePtyDir' in options ? options.nodePtyDir : resolveNodePtyDir()
  if (!nodePtyDir) {
    return {
      status: 'blocked',
      slot,
      abi,
      reason: 'dependency_missing',
      detail: 'node-pty is not resolvable from this install'
    }
  }

  // Why install before probing: on a toolchain-free deployment the compiled binary does
  // not exist yet, and the shipped slot is the only thing that can make the probe pass.
  let prebuilt: PrebuiltSlotOutcome | undefined
  if (!existsSync(join(nodePtyDir, 'build', 'Release', 'pty.node'))) {
    prebuilt = installPrebuiltSlot({
      abi,
      nodePtyDir,
      ...(options.prebuildsDir === undefined ? {} : { prebuildsDir: options.prebuildsDir })
    })
  }

  let result: ProcessResult
  try {
    result = runProcessSync({
      program: process.execPath,
      args: ['-e', buildNodePtyLoadProbeScript(nodePtyDir)],
      timeoutMs: PROBE_TIMEOUT_MS
    })
  } catch (error) {
    return {
      status: 'unverifiable',
      slot,
      abi,
      reason: 'unknown',
      detail: `the node-pty load probe could not be started: ${(error as Error).message}`,
      ...(prebuilt ? { prebuilt } : {})
    }
  }
  const failure = classifyNodePtyProbeResult(result)
  if (failure) {
    return {
      status: failure.status,
      slot,
      abi,
      reason: failure.reason,
      detail: failure.detail,
      ...(prebuilt ? { prebuilt } : {})
    }
  }

  // Loaded. The remaining way terminals fail is spawn-time: on macOS node-pty posix_spawns
  // build/Release/spawn-helper, and a missing one turns every terminal.create into ENOENT
  // on a host that otherwise looks healthy. That is a degradation, not a boot blocker.
  const outcome = readNodePtyProbeOutcome(result)
  const loadedDir = outcome.kind === 'loaded' ? outcome.loadedDir : null
  if (usesNodePtySpawnHelper(abi.platform)) {
    const helper = join(loadedDir || join(nodePtyDir, 'build', 'Release'), 'spawn-helper')
    if (!isExecutableFile(helper)) {
      return {
        status: 'degraded',
        slot,
        abi,
        reason: 'spawn_helper_missing',
        detail: `expected an executable at ${helper}`,
        ...(prebuilt ? { prebuilt } : {})
      }
    }
  }
  return { status: 'ok', slot, abi, ...(prebuilt ? { prebuilt } : {}) }
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** The operator-facing report. Names the host, the cause, and the next action. */
export function formatNodePtyPreconditionReport(
  verdict: NodePtyPreconditionVerdict,
  message: string,
  toolchainHints: string[] = []
): string {
  const { abi } = verdict
  const host = [
    `platform ${abi.platform}/${abi.arch}`,
    abi.libc === 'none'
      ? null
      : `libc ${abi.libc}${abi.glibcVersion ? ` ${abi.glibcVersion}` : ''}`,
    `Node ABI ${abi.nodeAbi}`,
    `prebuild slot ${verdict.slot}`
  ]
    .filter((part): part is string => part !== null)
    .join(', ')
  const lines = [message, '', `Host: ${host}`]
  if (verdict.prebuilt && !verdict.prebuilt.installed) {
    lines.push(
      verdict.prebuilt.why === 'no-slot'
        ? `No shipped prebuilt matches slot ${verdict.slot}.`
        : verdict.prebuilt.why === 'no-prebuilds-dir'
          ? 'This install ships no prebuilds directory.'
          : `Shipped prebuilds are unusable here: ${verdict.prebuilt.detail ?? 'ABI mismatch'}.`
    )
  }
  if (toolchainHints.length > 0) {
    lines.push('', 'To build node-pty on this host, install a C/C++ toolchain:', ...toolchainHints)
  }
  return lines.join('\n')
}

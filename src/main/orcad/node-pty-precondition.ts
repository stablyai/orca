// Probe node-pty in a child before any require: native loader aborts cannot be caught in-process.
import { existsSync, accessSync, constants } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { runProcessSync } from '@orca/process-host'
import type { ProcessResult } from '@orca/process-host/process-spec'
import { usesNodePtySpawnHelper } from '../../shared/node-pty-spawn-helper'
import type { RuntimeTerminalUnavailableReason } from '../../shared/runtime-types'
import {
  buildToolchainProbeCommand,
  parseBuildToolchainProbe,
  toolchainInstallHintLines
} from './build-toolchain-diagnosis'
import { detectNativeHostAbi, nativeSlotName, type NativeHostAbi } from './native-host-abi'
import { classifyNodePtyLoaderMessage, firstErrorLine } from './node-pty-loader-diagnosis'
import { installPrebuiltSlot, type PrebuiltSlotOutcome } from './node-pty-prebuilt-slot'

// Parse stdout verdicts only; Node may echo the script’s own token strings into stderr.
const PROBE_OK_TOKEN = 'ORCA_NODE_PTY_LOAD_OK'
const NO_BINARY_TOKEN = 'ORCA_NODE_PTY_NO_BINARY'
const LOAD_ERROR_TOKEN = 'ORCA_NODE_PTY_LOAD_ERROR'
const PROBE_TIMEOUT_MS = 20_000

/** Degraded allows other services; blocked proves unloadable; unverifiable proves nothing about the addon. */
type NodePtyPreconditionStatus = 'ok' | 'degraded' | 'blocked' | 'unverifiable'

export type NodePtyPreconditionVerdict = {
  status: NodePtyPreconditionStatus
  slot: string
  abi: NativeHostAbi
  reason?: RuntimeTerminalUnavailableReason
  detail?: string
  prebuilt?: PrebuiltSlotOutcome
}

type NodePtyProbeFailure = {
  status: 'blocked' | 'unverifiable'
  reason: RuntimeTerminalUnavailableReason
  detail: string
}

type NodePtyProbeOutcome =
  | { kind: 'loaded'; loadedDir: string | null }
  | { kind: 'noBinary' }
  | { kind: 'loaderError'; message: string }
  | { kind: 'signalled'; signal: NodeJS.Signals }
  | { kind: 'unanswered'; detail: string }
  | { kind: 'unexplained'; detail: string }

function readNodePtyProbeOutcome(
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
  // Loader aborts can signal without emitting a verdict; prioritize the signal.
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

function classifyLoaderMessage(message: string): NodePtyProbeFailure {
  return { status: 'blocked', ...classifyNodePtyLoaderMessage(message) }
}

/** Dlopen before the wrapper can hide loader failures as module misses; print caught causes
 * as stdout verdicts, while uncatchable loader aborts remain child signals. */
export function buildNodePtyLoadProbeScript(nodePtyDir: string): string {
  const entry = JSON.stringify(join(nodePtyDir, 'lib', 'index.js'))
  const utils = JSON.stringify(join(nodePtyDir, 'lib', 'utils.js'))
  const root = JSON.stringify(nodePtyDir)
  // Follow node-pty’s search order and platform module name; Windows defers conpty until spawn.
  return [
    `const fs=require('fs'),p=require('path');`,
    `const n=process.platform==='win32'&&Number(require('os').release().split('.')[2])>=18309?'conpty':'pty';`,
    `let f=null;`,
    `for(const d of ['build/orca-napi-'+process.platform+'-'+process.arch,'build/Release','build/Debug','prebuilds/'+process.platform+'-'+process.arch]){`,
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
    // Resolve without loading; native execution belongs only in the child.
    return dirname(require.resolve('node-pty/package.json'))
  } catch {
    return null
  }
}

export function probeLocalBuildToolchainHints(platform: NodeJS.Platform): string[] {
  if (platform === 'win32') {
    return []
  }
  // Generic Linux package-manager hints are wrong for macOS.
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
  // Explicit null disables detection; nullish fallback would erase that caller choice.
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

  // Toolchain-free installs need the shipped slot before any load probe can pass.
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

  // macOS spawn-helper failures degrade terminals without blocking otherwise healthy host services.
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
          : `Shipped prebuilds are unusable here: ${verdict.prebuilt.detail ?? verdict.prebuilt.why}.`
    )
  }
  if (toolchainHints.length > 0) {
    lines.push('', 'To build node-pty on this host, install a C/C++ toolchain:', ...toolchainHints)
  }
  return lines.join('\n')
}

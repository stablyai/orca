/**
 * Why the remote host cannot spawn terminals, in terms the user can act on and check.
 *
 * The relay used to answer this with one hedged paragraph — "install build tools, or
 * else reconnect, or else check your Node version" — because the only thing it looked at
 * was that `require('node-pty')` threw. That paragraph names three different remedies for
 * four different faults and lets the user verify none of them.
 *
 * node-pty's own loader is why the raw cause went missing: it walks build/Release,
 * build/Debug and prebuilds/<platform>-<arch>, then rethrows only the LAST error. So a
 * `pty.node` the dynamic loader refused arrives as `Cannot find module '../prebuilds/…'`,
 * and the GLIBC/ABI/arch sentence that actually says what is wrong is discarded before
 * the relay ever sees it. Recovering it needs a separate dlopen of the file the loader
 * would have opened — see node-pty-binding-survey.ts.
 *
 * Everything here is pure so every verdict is testable from a host that is none of the
 * hosts that break. `unverifiable` is a first-class outcome: a probe that did not answer
 * is not a diagnosis (docs/reference/ssh-execution-boundary.md).
 */
import { GLIBC_FLOOR, nativeSlotName, type NativeHostAbi } from '../main/orcad/native-host-abi'
import {
  classifyNodePtyLoaderMessage,
  isFlattenedNodePtyLoaderMessage
} from '../main/orcad/node-pty-loader-diagnosis'
import {
  toolchainInstallHintLines,
  type BuildToolchainStatus
} from '../main/ssh/build-toolchain-diagnosis'
import type { RuntimeTerminalUnavailableReason } from '../shared/runtime-types'
import type { TerminalUnavailableCause } from '../shared/terminal-unavailable-cause'

/** What is actually on disk where node-pty's loader looks, and what it was built for. */
export type NodePtyBindingSurvey = {
  /** The node-pty install the relay would load from. */
  moduleDir: string
  /** The compiled binding the loader would open, or null when no directory holds one. */
  bindingPath: string | null
  /** Directories checked, so "nothing is installed" is a statement with evidence. */
  searched: string[]
  /** `node_module_version` from node-gyp's build/config.gypi, when it is readable. */
  builtNodeAbi: string | null
  /** `target_arch` from node-gyp's build/config.gypi, when it is readable. */
  builtArch: string | null
}

export type NodePtyUnavailableHost = NativeHostAbi & { nodeVersion: string }

export type NodePtyUnavailableDiagnosis = {
  /** `blocked` — proved. `unverifiable` — nothing answered, which is not evidence. */
  status: 'blocked' | 'unverifiable'
  reason: RuntimeTerminalUnavailableReason
  host: NodePtyUnavailableHost
  /** Short phrase naming the values found. */
  detail: string
  /** The loader's own words, kept verbatim so an unclassified verdict is still reportable. */
  rawError: string | null
  survey: NodePtyBindingSurvey | null
  toolchain: BuildToolchainStatus | null
}

export type NodePtyDiagnosisInput = {
  /** What the recovered dlopen said, when one ran. Preferred over `requireError`. */
  loaderError?: string | null
  /** What `require('node-pty')`/`pty.spawn` threw. Usually flattened by node-pty. */
  requireError?: string | null
  /** A load probe that was killed rather than answering. */
  probeSignal?: NodeJS.Signals | null
  /** Set when the load probe never answered at all; forces `unverifiable`. */
  unverifiableBecause?: string | null
  host: NodePtyUnavailableHost
  survey: NodePtyBindingSurvey | null
  toolchain?: BuildToolchainStatus | null
}

/** Reasons a loader message can establish on its own, and which nothing else outranks. */
const LOADER_NAMED_FAULTS: ReadonlySet<RuntimeTerminalUnavailableReason> = new Set([
  'abi_mismatch',
  'arch_mismatch',
  'libc_floor',
  'shared_library_missing'
])

export function diagnoseNodePtyUnavailable(
  input: NodePtyDiagnosisInput
): NodePtyUnavailableDiagnosis {
  const { host, survey } = input
  const toolchain = input.toolchain ?? null
  // Why the require error is only a fallback: node-pty flattens the real cause away, so
  // its text is evidence of "did not load", never of why.
  const usableRequireError =
    input.requireError && !isFlattenedNodePtyLoaderMessage(input.requireError)
      ? input.requireError
      : null
  // Capped because a macOS dlopen error lists every path it tried; the message quotes this
  // verbatim when nothing classifies it, and a toast is not a log file.
  const rawError = truncate(input.loaderError ?? usableRequireError ?? input.requireError ?? null)
  const base = { host, rawError, survey, toolchain } as const

  if (input.unverifiableBecause) {
    return {
      ...base,
      status: 'unverifiable',
      reason: 'unknown',
      detail: input.unverifiableBecause
    }
  }
  // Before anything the loader said: a binary that aborts inside the loader never reaches
  // a catch and often prints nothing, so the signal is the only evidence there is.
  if (input.probeSignal) {
    return {
      ...base,
      status: 'blocked',
      reason: 'load_crashed',
      detail: `loading the binding killed the probe with ${input.probeSignal}`
    }
  }

  const classifiable = input.loaderError ?? usableRequireError
  const classified = classifiable ? classifyNodePtyLoaderMessage(classifiable) : null
  // Only a loader message that named the fault outranks the build record. `load_failed`
  // and `dependency_missing` do not: the first named nothing, and the second is what
  // node-pty says about a binding it never reached.
  if (classified && LOADER_NAMED_FAULTS.has(classified.reason)) {
    return { ...base, status: 'blocked', ...classified }
  }

  // The loader said nothing usable. The binding's own build record still can: node-gyp
  // records the ABI and arch it configured for, and either differing from this runtime is
  // a fault the user can check without reproducing the load.
  if (survey?.bindingPath) {
    if (survey.builtNodeAbi && survey.builtNodeAbi !== host.nodeAbi) {
      return {
        ...base,
        status: 'blocked',
        reason: 'abi_mismatch',
        detail: `built for Node ABI ${survey.builtNodeAbi}, this host runs ABI ${host.nodeAbi}`
      }
    }
    if (survey.builtArch && survey.builtArch !== host.arch) {
      return {
        ...base,
        status: 'blocked',
        reason: 'arch_mismatch',
        detail: `built for ${survey.builtArch}, this host runs ${host.arch}`
      }
    }
    return {
      ...base,
      status: 'blocked',
      reason: classified?.reason ?? 'load_failed',
      detail: classified?.detail ?? 'the binding is present but the loader refused it'
    }
  }

  if (!survey) {
    return {
      ...base,
      status: 'unverifiable',
      reason: 'unknown',
      detail: "the relay could not read node-pty's install directory"
    }
  }
  // Nothing compiled anywhere. On Linux that is either a compile that never ran for want
  // of a toolchain, or an install that failed for some other reason — different remedies.
  if (toolchain?.toolchainMissing) {
    return {
      ...base,
      status: 'blocked',
      reason: 'toolchain_missing',
      detail: `no compiled binding exists and ${missingToolSummary(toolchain)} missing`
    }
  }
  return {
    ...base,
    status: 'blocked',
    reason: 'dependency_missing',
    detail: 'no compiled node-pty binding exists on this host'
  }
}

const RAW_ERROR_MAX = 600

function truncate(message: string | null): string | null {
  if (message === null || message.length <= RAW_ERROR_MAX) {
    return message
  }
  return `${message.slice(0, RAW_ERROR_MAX)}…`
}

function missingToolSummary(toolchain: BuildToolchainStatus): string {
  const present = new Set(toolchain.present)
  const missing: string[] = []
  if (!present.has('make')) {
    missing.push('make')
  }
  if (!present.has('g++') && !present.has('c++') && !present.has('clang++')) {
    missing.push('a C++ compiler')
  }
  if (!present.has('python3') && !present.has('python')) {
    missing.push('python3')
  }
  if (missing.length <= 1) {
    return `${missing[0] ?? 'the build tools'} is`
  }
  return `${missing.slice(0, -1).join(', ')} and ${missing.at(-1)} are`
}

/**
 * Faults a rebuild on the host actually fixes.
 *
 * The relay's node-pty is compiled ON the remote by `npm install`, so a binding that is
 * absent, built for another Node ABI, built for another architecture, or linked against a
 * newer libc than the host provides is all one thing: the compiled artifact no longer
 * matches the machine, and recompiling here produces one that does. That is different
 * from the packaged desktop app, where the binary is built elsewhere and the glibc floor
 * in docs/reference/linux-glibc-compatibility.md is the binding constraint.
 *
 * Excluded on purpose: `toolchain_missing` (no compiler to rebuild with) and
 * `shared_library_missing` (the compile would need the same absent library).
 */
const REBUILD_FIXES: ReadonlySet<RuntimeTerminalUnavailableReason> = new Set([
  'abi_mismatch',
  'arch_mismatch',
  'libc_floor',
  'load_crashed',
  'dependency_missing'
])

/**
 * The machine-readable cause, for a client that can act instead of printing.
 *
 * `repairable` requires a proved status AND a toolchain that is not known-missing: a
 * rebuild the host cannot perform is not a repair, it is a wasted `npm install` — which
 * is the shape of #14830.
 */
export function toTerminalUnavailableCause(
  diagnosis: NodePtyUnavailableDiagnosis
): TerminalUnavailableCause {
  const { host } = diagnosis
  return {
    status: diagnosis.status,
    reason: diagnosis.reason,
    detail: diagnosis.detail.slice(0, 400),
    repairable:
      diagnosis.status === 'blocked' &&
      REBUILD_FIXES.has(diagnosis.reason) &&
      diagnosis.toolchain?.toolchainMissing !== true,
    host: {
      platform: host.platform,
      arch: host.arch,
      libc: host.libc,
      ...(host.glibcVersion ? { glibcVersion: host.glibcVersion } : {}),
      nodeAbi: host.nodeAbi,
      nodeVersion: host.nodeVersion
    },
    ...(diagnosis.rawError ? { rawError: diagnosis.rawError.slice(0, 1000) } : {})
  }
}

/** `linux/x64, glibc 2.31, Node v20.11.0 (ABI 115), prebuild slot linux-x64-glibc`. */
function formatNodePtyHostLine(host: NodePtyUnavailableHost): string {
  const libc =
    host.libc === 'none' ? null : `${host.libc}${host.glibcVersion ? ` ${host.glibcVersion}` : ''}`
  return [
    `${host.platform}/${host.arch}`,
    libc,
    `Node ${host.nodeVersion} (ABI ${host.nodeAbi})`,
    `prebuild slot ${nativeSlotName(host)}`
  ]
    .filter((part): part is string => part !== null)
    .join(', ')
}

/**
 * One remedy per fault, each naming a value the user can go and check.
 *
 * `unverifiable` deliberately prescribes nothing: the relay proved only that it could not
 * establish a cause, and dressing that up as a diagnosis is the bug this replaces.
 */
export function formatNodePtyUnavailableMessage(diagnosis: NodePtyUnavailableDiagnosis): string {
  const { host } = diagnosis
  // Unverifiable deliberately prescribes nothing beyond a retry: nothing was established,
  // and dressing that up as a diagnosis is the bug this replaces.
  const opening =
    diagnosis.status === 'unverifiable'
      ? `Remote terminals are unavailable, and the relay could not establish why: ${diagnosis.detail}. ` +
        `That is not evidence node-pty is broken — reconnect to retry.`
      : `Remote terminals are unavailable: ${remedyFor(diagnosis)}`
  const lines = [opening, `Host: ${formatNodePtyHostLine(host)}.`]
  // Quoted only where nothing else named the fault: elsewhere the remedy already carries
  // the numbers, and a dlopen dump would bury them.
  const quoteRaw =
    diagnosis.status === 'unverifiable' ||
    diagnosis.reason === 'load_failed' ||
    diagnosis.reason === 'unknown'
  if (diagnosis.rawError && quoteRaw) {
    lines.push(`Loader error: ${diagnosis.rawError}`)
  }
  return lines.join('\n')
}

function remedyFor(diagnosis: NodePtyUnavailableDiagnosis): string {
  const { host, survey, toolchain } = diagnosis
  switch (diagnosis.reason) {
    case 'toolchain_missing':
      return (
        `node-pty ships no prebuilt binary for Linux and this host has no compiled one ` +
        `(${searchedPhrase(survey)}), because ${toolchain ? missingToolSummary(toolchain) : 'the build tools are'} not installed. ` +
        `Install them on the remote host, then reconnect:\n` +
        `${(toolchain ? toolchainInstallHintLines(toolchain) : []).join('\n')}`
      )
    case 'dependency_missing':
      return (
        `node-pty has no compiled binary on this host (${searchedPhrase(survey)}). ` +
        `The C/C++ build tools needed to compile it are present, so reconnect to reinstall ` +
        `the relay's native modules.`
      )
    case 'abi_mismatch':
      return (
        `the installed node-pty binding was built for a different Node ABI than the remote's ` +
        `Node — ${diagnosis.detail}. Reconnect to rebuild node-pty against ${host.nodeVersion}, ` +
        `or run the relay on the Node version the binding was built for.`
      )
    case 'arch_mismatch':
      return (
        `the installed node-pty binding does not match this host's CPU architecture — ` +
        `${diagnosis.detail}. Reconnect to rebuild node-pty on the remote host; a binding ` +
        `copied from a machine of another architecture can never load here.`
      )
    case 'libc_floor':
      return (
        `${diagnosis.detail}, which this host's C library does not provide ` +
        `(${host.glibcVersion ? `glibc ${host.glibcVersion}` : 'this host reports no glibc version'}). ` +
        `The binding was compiled on a newer system than this one. Reconnect to rebuild ` +
        `node-pty here; Orca's own Linux floor is glibc ${GLIBC_FLOOR}.`
      )
    case 'shared_library_missing':
      return (
        `node-pty's native binding cannot be opened because ${diagnosis.detail}. ` +
        `Install that library on the remote host, then reconnect.`
      )
    case 'load_crashed':
      return (
        `${diagnosis.detail}, which means the binding is incompatible with this host rather ` +
        `than missing. Reconnect to rebuild the relay's native modules.`
      )
    case 'load_failed':
    case 'spawn_helper_missing':
    case 'unknown':
      return (
        `this host refused to load node-pty's native binding and the cause was not recognized. ` +
        `Reconnect to rebuild the relay's native modules; if that does not help, please file an ` +
        `issue quoting the loader error below.`
      )
  }
}

function searchedPhrase(survey: NodePtyBindingSurvey | null): string {
  return survey && survey.searched.length > 0
    ? `checked ${survey.searched.join(', ')} under ${survey.moduleDir}`
    : 'nothing was found where node-pty looks'
}

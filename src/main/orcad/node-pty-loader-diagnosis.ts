/**
 * Read a dynamic-loader message and name the one thing that has to change.
 *
 * Pure on purpose: every shape that matters here belongs to a host we are not — Alpine,
 * Ubuntu 20.04, an arm64 box handed an x64 binary — so the classification has to be
 * testable from a machine that cannot reproduce any of them.
 *
 * Shared by the two places a node-pty load can fail: `orcad`'s boot precondition
 * (out of process, before anything requires node-pty) and the SSH relay's spawn path.
 */
import type { RuntimeTerminalUnavailableReason } from '../../shared/runtime-types'
import {
  parseIncompatibleArchitecture,
  parseMissingSharedLibrary,
  parseNodeAbiMismatch,
  parseUnmetGlibcVersion
} from './native-host-abi'

export type NodePtyLoadCause = {
  reason: RuntimeTerminalUnavailableReason
  /** Short human phrase naming the actual values found, not a remedy. */
  detail: string
}

/**
 * node-pty's own loader walks several directories and rethrows only the LAST failure,
 * wrapped in this sentence. The tail is therefore the `prebuilds/<platform>-<arch>`
 * miss — `Cannot find module` — even when the real failure was the dynamic loader
 * refusing `build/Release/pty.node`. Anything acting on that tail sends the operator to
 * install a module that is already installed.
 */
export function isFlattenedNodePtyLoaderMessage(message: string): boolean {
  return /Failed to load native module: (?:conpty|pty)\.node(?:,|:|$)/.test(message)
}

/** The real cause a flattened message still carries, when the last attempt was the telling one. */
export function classifyNodePtyLoaderMessage(message: string): NodePtyLoadCause {
  const abiMismatch = parseNodeAbiMismatch(message)
  if (abiMismatch) {
    return {
      reason: 'abi_mismatch',
      detail: `built for Node ABI ${abiMismatch.built}, this host runs ABI ${abiMismatch.host}`
    }
  }
  const unmetGlibc = parseUnmetGlibcVersion(message)
  if (unmetGlibc) {
    return { reason: 'libc_floor', detail: `the binary requires GLIBC_${unmetGlibc}` }
  }
  const unmetCxx = message.match(/((?:GLIBCXX_|CXXABI_)[0-9.]+)'? not found/)
  if (unmetCxx) {
    return { reason: 'libc_floor', detail: `the binary requires ${unmetCxx[1]}` }
  }
  const arch = parseIncompatibleArchitecture(message)
  if (arch) {
    return {
      reason: 'arch_mismatch',
      detail:
        arch.built && arch.host
          ? `built for ${arch.built}, this host needs ${arch.host}`
          : `the loader rejected the binary's format (${firstErrorLine(message)})`
    }
  }
  const missingLibrary = parseMissingSharedLibrary(message)
  if (missingLibrary) {
    return {
      reason: 'shared_library_missing',
      detail: `${missingLibrary} is not installed on this host`
    }
  }
  if (/MODULE_NOT_FOUND|Cannot find module/.test(message)) {
    return { reason: 'dependency_missing', detail: firstErrorLine(message) }
  }
  return { reason: 'load_failed', detail: firstErrorLine(message) }
}

/**
 * Why not simply the first non-empty line: when a child dies without catching, node
 * prints the offending source line and a caret before the error, so line one is the
 * script rather than the diagnosis. Prefer the first line that reads as an error.
 */
export function firstErrorLine(text: string): string {
  const lines = text.split('\n').filter((candidate) => candidate.trim().length > 0)
  const errorLine = lines.find((candidate) => /^[A-Za-z]*(Error|Exception):/.test(candidate.trim()))
  return (errorLine ?? lines[0] ?? text).trim().slice(0, 400)
}

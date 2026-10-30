import type { RuntimeTerminalUnavailableReason } from '../../shared/runtime-types'
import {
  parseIncompatibleArchitecture,
  parseMissingSharedLibrary,
  parseNodeAbiMismatch,
  parseUnmetGlibcVersion
} from './native-host-abi'

type NodePtyLoadCause = {
  reason: RuntimeTerminalUnavailableReason
  detail: string
}

// node-pty rethrows its last directory miss, which can hide the original native loader refusal.
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

/** Skip source/caret echoes from uncaught child errors and prefer an actual error line. */
export function firstErrorLine(text: string): string {
  const lines = text.split('\n').filter((candidate) => candidate.trim().length > 0)
  const errorLine = lines.find((candidate) => /^[A-Za-z]*(Error|Exception):/.test(candidate.trim()))
  return (errorLine ?? lines[0] ?? text).trim().slice(0, 400)
}

/**
 * The native precondition orcad runs before its runtime loads anything native.
 *
 * Split from `node-pty-precondition.ts` so the decision (what to do about a verdict) is
 * testable apart from the detection (what the verdict is).
 */
import process from 'node:process'
import { setRuntimeTerminalUnavailableCause } from '../runtime/native-terminal-availability'
import { terminalUnavailableMessage } from '../../shared/runtime-types'
import {
  checkNodePtyPrecondition,
  formatNodePtyPreconditionReport,
  probeLocalBuildToolchainHints,
  type NodePtyPreconditionVerdict
} from './node-pty-precondition'

/**
 * EX_CONFIG. Why not 1: a supervisor that restarts on 1 would restart forever against a
 * host that can never load this binary. This code says "the host is not equipped", which
 * is a different instruction from "it crashed".
 */
export const ORCAD_NATIVE_PRECONDITION_EXIT_CODE = 78

export type NativePreflightHooks = {
  check?: () => NodePtyPreconditionVerdict
  toolchainHints?: (platform: NodeJS.Platform) => string[]
  warn?: (message: string) => void
  fail?: (message: string) => void
  exit?: (code: number) => never
}

/**
 * Returns true when boot may continue.
 *
 * A `blocked` verdict never returns: continuing would reach the very `require` the probe
 * just proved fatal, and the operator would get the loader's stack trace instead of the
 * sentence printed here.
 */
export function runOrcadNativePreflight(hooks: NativePreflightHooks = {}): boolean {
  const check = hooks.check ?? checkNodePtyPrecondition
  const warn = hooks.warn ?? ((message: string) => console.warn(message))
  const fail = hooks.fail ?? ((message: string) => console.error(message))
  const exit = hooks.exit ?? ((code: number) => process.exit(code) as never)
  const verdict = check()

  if (verdict.status === 'ok') {
    // Why clear rather than leave alone: a previous run in this process may have recorded
    // a cause, and status.get must not keep reporting a degradation that no longer holds.
    setRuntimeTerminalUnavailableCause(null)
    return true
  }

  const reason = verdict.reason ?? 'unknown'
  setRuntimeTerminalUnavailableCause({
    reason,
    ...(verdict.detail ? { detail: verdict.detail } : {})
  })
  const message = terminalUnavailableMessage(reason, verdict.detail)

  if (verdict.status === 'blocked') {
    const hints = (hooks.toolchainHints ?? probeLocalBuildToolchainHints)(verdict.abi.platform)
    fail(`orcad: ${formatNodePtyPreconditionReport(verdict, message, hints)}`)
    exit(ORCAD_NATIVE_PRECONDITION_EXIT_CODE)
    return false
  }

  // `degraded` and `unverifiable` both boot. The first is a proven spawn-time fault the
  // host can still serve around; the second established nothing, and refusing to boot on
  // an inconclusive probe would take down hosts that work.
  warn(`orcad: ${formatNodePtyPreconditionReport(verdict, message)}`)
  return true
}

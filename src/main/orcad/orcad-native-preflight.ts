import process from 'node:process'
import { setRuntimeTerminalUnavailableCause } from '../runtime/native-terminal-availability'
import { terminalUnavailableMessage } from '../../shared/runtime-types'
import {
  checkNodePtyPrecondition,
  formatNodePtyPreconditionReport,
  probeLocalBuildToolchainHints,
  type NodePtyPreconditionVerdict
} from './node-pty-precondition'
import { ORCAD_EXIT_CONFIGURATION } from './orcad-configuration-exit'

type NativePreflightHooks = {
  check?: () => NodePtyPreconditionVerdict
  toolchainHints?: (platform: NodeJS.Platform) => string[]
  warn?: (message: string) => void
  fail?: (message: string) => void
  exit?: (code: number) => never
}

/** Abort proven load failures before native require; inconclusive probes may still boot. */
export function runOrcadNativePreflight(hooks: NativePreflightHooks = {}): boolean {
  const check = hooks.check ?? checkNodePtyPrecondition
  const warn = hooks.warn ?? ((message: string) => console.warn(message))
  const fail = hooks.fail ?? ((message: string) => console.error(message))
  const exit = hooks.exit ?? ((code: number) => process.exit(code) as never)
  const verdict = check()

  if (verdict.status === 'ok') {
    // Clear stale degradation when this process probes successfully again.
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
    exit(ORCAD_EXIT_CONFIGURATION)
    return false
  }

  // Spawn faults permit other RPCs; inconclusive probes cannot justify refusing startup.
  // host can still serve around; the second established nothing, and refusing to boot on
  // an inconclusive probe would take down hosts that work.
  warn(`orcad: ${formatNodePtyPreconditionReport(verdict, message)}`)
  return true
}

import type {
  IdentityProbe,
  IdentityProbeOutput
} from '../../shared/agent-launch/catalog/tui-agent-identity-exclusion'
import {
  getPreflightWslTarget,
  type PreflightRuntimeContext
} from '../ipc/preflight-runtime-target'
import {
  execCommandInWslOrThrow,
  execLocalPreflightCommandOrThrow
} from '../ipc/preflight-command-exec'
import { quotePosixShell } from '../../shared/shell/launch/shell-argument-quoting'
import { resolveAgentCommandPathOnHost } from './agent-command-detection'

// Why cache by resolved path: the identity probe spawns the CLI (`bob --help`
// is ~0.6 s), and detection runs per renderer preflight, per mobile RPC and per
// draft startup. A binary at a given path does not change identity mid-session;
// Refresh and the test reset clear it. Failures are not cached so a transient
// error (fail-open keep) is re-checked next time.
const identityProbeOutputs = new Map<string, Promise<IdentityProbeOutput>>()

function cachedIdentityProbe(cacheKey: string, run: () => Promise<IdentityProbeOutput>) {
  const existing = identityProbeOutputs.get(cacheKey)
  if (existing) {
    return existing
  }
  const pending = run()
  identityProbeOutputs.set(cacheKey, pending)
  pending.catch(() => identityProbeOutputs.delete(cacheKey))
  return pending
}

/** Probes the executable detection actually matched, never a bare name re-resolved on PATH. */
export function buildIdentityProbe(
  resolveProgram: (command: string) => Promise<string | null>,
  runtimeKey: string,
  runProgram: (program: string, args: readonly string[]) => Promise<IdentityProbeOutput>
): IdentityProbe {
  return async (command, args) => {
    const program = await resolveProgram(command)
    if (!program) {
      throw new Error(`${command} has no resolved path to probe`)
    }
    return cachedIdentityProbe(`${runtimeKey}:${program}`, () => runProgram(program, args))
  }
}

/** Refresh and the test reset call this: what is installed may just have changed. */
export function clearIdentityProbeCache(): void {
  identityProbeOutputs.clear()
}

/** Identity probe for the detection host: the WSL guest, or this machine. */
export function buildHostIdentityProbe(context?: PreflightRuntimeContext): IdentityProbe {
  const resolveProgram = (command: string) => resolveAgentCommandPathOnHost(command, context)
  const wslTarget = getPreflightWslTarget(context)
  if (wslTarget) {
    return buildIdentityProbe(resolveProgram, `wsl:${wslTarget.distro ?? ''}`, (program, args) =>
      execCommandInWslOrThrow(wslTarget, [program, ...args].map(quotePosixShell).join(' '))
    )
  }
  return buildIdentityProbe(resolveProgram, 'local', (program, args) =>
    execLocalPreflightCommandOrThrow(program, [...args], { terminationBarrier: true })
  )
}

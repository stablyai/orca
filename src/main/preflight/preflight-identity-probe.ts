import type { IdentityProbe, IdentityProbeOutput } from '../../shared/tui-agent-identity-exclusion'

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
  resolvedPaths: ReadonlyMap<string, string>,
  runtimeKey: string,
  runProgram: (program: string, args: readonly string[]) => Promise<IdentityProbeOutput>
): IdentityProbe {
  return (command, args) => {
    const program = resolvedPaths.get(command)
    if (!program) {
      return Promise.reject(new Error(`${command} has no resolved path to probe`))
    }
    return cachedIdentityProbe(`${runtimeKey}:${program}`, () => runProgram(program, args))
  }
}

/** Refresh and the test reset call this: what is installed may just have changed. */
export function clearIdentityProbeCache(): void {
  identityProbeOutputs.clear()
}

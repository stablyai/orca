import { spawnProcess } from '@orca/process-host'
import type { ChildProcess } from 'node:child_process'
import type { PipedProcessSpec } from '@orca/process-host/process-spec'
import type { ProviderChild } from './provider-child'
import type { ProviderSpawnSpec } from './provider-process-supervisor'
import { DirectProviderChild } from './direct-provider-child'
import { LegacyProviderChild } from './legacy-provider-child'
import { providerOwnershipAvailable } from './provider-ownership-journal'
import { createLegacyProviderSpawnSpec } from './legacy-provider-supervisor'

export type ProviderProcessSpawner = (spec: PipedProcessSpec) => ChildProcess

/** Shared launch seam; ownership stays in this runtime until a compatible host contract exists. */
export function spawnProviderProcess(
  spec: ProviderSpawnSpec,
  spawnImpl: ProviderProcessSpawner = spawnProcess
): ProviderChild {
  const native = spec.supervised && providerOwnershipAvailable()
  const raw = spawnImpl(
    spec.supervised && !native
      ? createLegacyProviderSpawnSpec(spec)
      : {
          program: spec.program,
          args: spec.args,
          cwd: spec.cwd,
          env: spec.env,
          detached: spec.detached,
          stdio: native
            ? ['pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe']
            : ['pipe', 'pipe', 'pipe']
        }
  )
  if (native) {
    return new DirectProviderChild(raw, spec)
  }
  if (spec.supervised) {
    return new LegacyProviderChild(raw, spec)
  }
  const { stdin, stdout, stderr } = raw
  if (!stdin || !stdout || !stderr) {
    raw.kill('SIGKILL')
    throw new Error('Provider launch did not create its required pipes')
  }
  const child = Object.assign(raw, { stdin, stdout, stderr })
  return child
}

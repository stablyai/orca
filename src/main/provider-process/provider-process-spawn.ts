import { spawnProcess } from '@orca/process-host'
import type { ChildProcess } from 'node:child_process'
import type { PipedProcessSpec } from '@orca/process-host/process-spec'
import type { ProviderChild } from './provider-child'
import type { ProviderSpawnSpec } from './provider-process-supervisor'
import { DirectProviderChild } from './direct-provider-child'

export type ProviderProcessSpawner = (spec: PipedProcessSpec) => ChildProcess

/** Shared launch seam; ownership stays in this runtime until a compatible host contract exists. */
export function spawnProviderProcess(
  spec: ProviderSpawnSpec,
  spawnImpl: ProviderProcessSpawner = spawnProcess,
  _allowHost = true
): ProviderChild {
  const raw = spawnImpl({
    program: spec.program,
    args: spec.args,
    cwd: spec.cwd,
    env: spec.env,
    detached: spec.detached,
    stdio: spec.supervised
      ? ['pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe']
      : ['pipe', 'pipe', 'pipe']
  })
  if (spec.supervised) {
    return new DirectProviderChild(raw, spec)
  }
  const { stdin, stdout, stderr } = raw
  if (!stdin || !stdout || !stderr) {
    raw.kill('SIGKILL')
    throw new Error('Provider launch did not create its required pipes')
  }
  const child = Object.assign(raw, { stdin, stdout, stderr })
  return child
}

import { spawnProcess } from '@orca/process-host'
import type { ChildProcess } from 'node:child_process'
import type { PipedProcessSpec, ProcessSpec } from '@orca/process-host/process-spec'
import type { ProviderChild } from './provider-child'
import { supervisedPosixLaunch, type ProviderSpawnSpec } from './provider-process-supervisor'
import { DirectProviderChild } from './direct-provider-child'
import { LegacyProviderChild } from './legacy-provider-child'
import { providerOwnershipBootId } from './provider-ownership-journal'

export type ProviderProcessSpawner = (spec: ProcessSpec) => ChildProcess

/** Shared launch seam; ownership stays in this runtime until a compatible host contract exists. */
export function spawnProviderProcess(
  spec: ProviderSpawnSpec,
  spawnImpl: ProviderProcessSpawner = spawnProcess
): ProviderChild {
  const bootId = spec.supervised ? providerOwnershipBootId() : null
  const native = bootId !== null
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
            ? ['ignore', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe']
            : ['pipe', 'pipe', 'pipe']
        }
  )
  if (bootId !== null) {
    return new DirectProviderChild(raw, spec, bootId)
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

/** The returned child is the legacy supervisor, including its PID and signal semantics. */
function createLegacyProviderSpawnSpec(spec: ProviderSpawnSpec): PipedProcessSpec {
  const legacy = supervisedPosixLaunch(
    { command: spec.command, args: spec.args.slice(7), cwd: spec.cwd },
    spec.env,
    spec
  )
  return {
    program: legacy.command,
    args: legacy.args,
    env: legacy.env,
    cwd: spec.cwd,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe', 'ipc']
  }
}

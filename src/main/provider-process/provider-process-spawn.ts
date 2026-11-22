import { spawnProcess } from '@orca/process-host'
import type { ChildProcess } from 'node:child_process'
import type { PipedProcessSpec, ProcessSpec } from '@orca/process-host/process-spec'
import type { ProviderChild } from './provider-child'
import { supervisedPosixLaunch, type ProviderSpawnSpec } from './provider-process-supervisor'
import { DirectProviderChild } from './direct-provider-child'
import { LegacyProviderChild } from './legacy-provider-child'
import { providerOwnershipBootId } from './provider-ownership-journal'
import { DeferredProviderOwner } from './deferred-provider-owner'
import {
  launchProviderOwner,
  type HostedCwdReporter,
  type ProviderHostRoute
} from './hosted-provider-launch'

export type ProviderProcessSpawner = (spec: ProcessSpec) => ChildProcess

let hostRoute: ProviderHostRoute | null = null

/** Only desktop composition installs this route; server and remote launchers keep direct spawn. */
export function installProviderProcessHost(
  getClient: ProviderHostRoute['getClient'],
  reportCwd: HostedCwdReporter = () => {}
): void {
  hostRoute = { getClient, reportCwd }
}

/** Shared launch seam; native owners may start under the host, but this runtime owns them. */
export function spawnProviderProcess(
  spec: ProviderSpawnSpec,
  spawnImpl: ProviderProcessSpawner = spawnProcess,
  allowHost = true
): ProviderChild {
  const bootId = spec.supervised ? providerOwnershipBootId() : null
  if (bootId !== null) {
    const spawnOwner = (): ChildProcess =>
      spawnImpl({
        program: spec.program,
        args: spec.args,
        cwd: spec.cwd,
        env: spec.env,
        detached: spec.detached,
        stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe']
      })
    const route = allowHost ? hostRoute : null
    if (!route) {
      return new DirectProviderChild(spawnOwner(), spec, bootId)
    }
    const owner = new DeferredProviderOwner()
    const child = new DirectProviderChild(owner, spec, bootId)
    void launchProviderOwner(owner, spec, route, spawnOwner)
    return child
  }
  const raw = spawnImpl(
    spec.supervised
      ? createLegacyProviderSpawnSpec(spec)
      : {
          program: spec.program,
          args: spec.args,
          cwd: spec.cwd,
          env: spec.env,
          detached: spec.detached,
          stdio: ['pipe', 'pipe', 'pipe']
        }
  )
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
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    // The provider it starts inherits only what this supervisor holds.
    closeInheritedFds: true
  }
}

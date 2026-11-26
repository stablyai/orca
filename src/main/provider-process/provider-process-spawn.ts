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
import { launchProviderOwnerOnWorker } from './worker-provider-owner-launch'
import { PROVIDER_BOOTSTRAP_DEADLINE_MS } from './provider-bootstrap-status'
import { OWNERSHIP_PROOF_WINDOW_MS } from './provider-ownership-launch-proof'
import { spawnWorkerReadyNow } from '../worker-thread-child-process/worker-thread-child-process'

const WORKER_START_BUDGET_MS = PROVIDER_BOOTSTRAP_DEADLINE_MS - OWNERSHIP_PROOF_WINDOW_MS - 1_000

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
    const allowWorkerFallback = spawnImpl === spawnProcess && process.platform !== 'win32'
    if (!route) {
      if (allowWorkerFallback && spawnWorkerReadyNow()) {
        const owner = new DeferredProviderOwner()
        const child = new DirectProviderChild(owner, spec, bootId)
        void launchProviderOwnerOnWorker(owner, spec, spawnOwner, WORKER_START_BUDGET_MS)
        return child
      }
      return new DirectProviderChild(spawnOwner(), spec, bootId)
    }
    const owner = new DeferredProviderOwner()
    const child = new DirectProviderChild(owner, spec, bootId)
    void launchProviderOwner(owner, spec, route, spawnOwner, allowWorkerFallback)
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
    stdio: ['pipe', 'pipe', 'pipe', 'ipc']
  }
}

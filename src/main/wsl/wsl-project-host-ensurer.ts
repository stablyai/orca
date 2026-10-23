import { readWslHostDeployments } from '../../shared/wsl-host-deployment-store'
import type { WslHostAddResult } from '../../shared/wsl-host-types'
import { admitWslHostDistro, sameWslDistro, wslHostRunRefusal } from './wsl-host-add-admission'
import type { WslHostDistroCandidate } from './wsl-host-distro-list'

type WslProjectHostDependencies = {
  userDataPath(): string
  isEnabled(): boolean
  hasServerFiles(): boolean
  listDistros(): Promise<WslHostDistroCandidate[]>
  add(distro: string): Promise<WslHostAddResult>
  connect(environmentId: string): Promise<void>
}

export class WslProjectHostEnsurer {
  private readonly ensuring = new Map<string, Promise<string>>()

  constructor(private readonly deps: WslProjectHostDependencies) {}

  /** Explicit project actions may start their distro, and wait for its paired server. */
  async ensure(distro: string): Promise<string> {
    const refusal = wslHostRunRefusal(this.deps)
    if (refusal) {
      throw new Error(refusal.message)
    }
    const admission = admitWslHostDistro({
      requested: distro,
      candidates: await this.deps.listDistros(),
      alreadyAdded: () => false,
      startIfStopped: true
    })
    if (!('distro' in admission)) {
      throw new Error(admission.message)
    }
    const candidate = admission.distro
    const pending = this.ensuring.get(candidate.id)
    if (pending) {
      return pending
    }
    const operation = this.ensureRegisteredDistro(candidate).finally(() =>
      this.ensuring.delete(candidate.id)
    )
    this.ensuring.set(candidate.id, operation)
    return operation
  }

  private async ensureRegisteredDistro(distro: WslHostDistroCandidate): Promise<string> {
    // A reused label must never attach a new registration to the previous guest's projects.
    const records = readWslHostDeployments(this.deps.userDataPath()).deployments
    const record = records.find((entry) => entry.distroId === distro.id)
    const named = records.find((entry) => sameWslDistro(entry.distro, distro.name))
    if ((named && named !== record) || (record && !sameWslDistro(record.distro, distro.name))) {
      throw new Error(
        `The WSL registration for ${distro.name} changed, so Orca cannot reuse its saved server. Open Settings → Orca servers to review the old server; reconnecting it will not repair the registration.`
      )
    }
    if (record) {
      await this.deps.connect(record.environmentId)
      return record.environmentId
    }
    const result = await this.deps.add(distro.name)
    if (!result.ok) {
      throw new Error(result.message)
    }
    return result.environmentId
  }
}

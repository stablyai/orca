import { makePaneKey } from '../../shared/stable-pane-id'
import { parsePtyOwnershipTransferSurfaceBinding } from '../../shared/pty-ownership-transfer-surface-binding'
import { allowsRelayWorkDuringDrain } from '../../shared/relay-work-drain-contract'

const LEGACY_CONTROLS = new Set([
  'pty.data',
  'pty.resize',
  'pty.shutdown',
  'pty.sendSignal',
  'pty.clearBuffer'
])
const CATALOG_CREATION = Symbol('catalog-creation')

/** Mux-lifetime history; a failed control is conservatively unresolved until explicit recovery exists. */
export class SshPtyPreparationAdmission {
  private readonly closed = new Set<string>()
  private readonly failed = new Set<string>()
  private readonly closedPanes = new Set<string>()
  private catalogCreationClosed = false
  private catalogCreationUnverifiable = false
  private relayResetClosed = false

  get isRelayResetClosed(): boolean {
    return this.relayResetClosed
  }

  closeForRelayReset(): void {
    this.relayResetClosed = true
  }

  admit(
    method: string,
    params?: Record<string, unknown>,
    notification = false
  ): string | typeof CATALOG_CREATION | null {
    if (this.relayResetClosed && !allowsRelayWorkDuringDrain(method, notification)) {
      throw new Error('relay_reset_work_admission_closed')
    }
    if (method === 'pty.spawn') {
      if (this.catalogCreationClosed) {
        throw new Error('orcad_source_catalog_preparing')
      }
      const env = params?.env as Record<string, unknown> | undefined
      if (
        [params?.paneKey, env?.ORCA_PANE_KEY].some(
          (key) => typeof key === 'string' && this.closedPanes.has(key)
        )
      ) {
        throw new Error('orcad_source_surface_preparing')
      }
      return CATALOG_CREATION
    }
    if (!LEGACY_CONTROLS.has(method) || typeof params?.id !== 'string') {
      return null
    }
    if (this.closed.has(params.id)) {
      throw new Error('orcad_source_control_preparing')
    }
    return params.id
  }

  recordFailure(id: ReturnType<SshPtyPreparationAdmission['admit']>): void {
    if (id === CATALOG_CREATION) {
      this.catalogCreationUnverifiable = true
    } else if (id !== null) {
      this.failed.add(id)
    }
  }

  isClosed(id: string): boolean {
    return this.closed.has(id)
  }

  closeCatalogCreation(): void {
    this.catalogCreationClosed = true
  }

  recordUnacknowledgedCreation(method: string): void {
    if (method === 'pty.spawn') {
      this.catalogCreationUnverifiable = true
    }
  }

  assertCatalogCreationSettled(): void {
    if (this.catalogCreationUnverifiable) {
      throw new Error('orcad_source_catalog_creation_unverifiable')
    }
  }

  closeSurface(value: unknown): void {
    const surface = parsePtyOwnershipTransferSurfaceBinding(value)
    this.closedPanes.add(makePaneKey(surface.tabId, surface.leafId))
  }

  close(id: string): void {
    if (!id.trim()) {
      throw new Error('orcad_source_control_terminal_invalid')
    }
    this.closed.add(id)
    this.assertSettled(id)
  }

  assertSettled(id: string): void {
    if (this.failed.has(id)) {
      throw new Error('orcad_source_control_outcome_unverifiable')
    }
  }
}

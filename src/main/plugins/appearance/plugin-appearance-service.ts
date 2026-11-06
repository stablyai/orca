import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { PluginThemeRegistration } from '../../../shared/plugins/artifacts/plugin-theme-artifact'
import type { PluginTerminalThemeRegistration } from '../../../shared/plugins/artifacts/plugin-terminal-theme-artifact'
import type {
  PluginHostParams,
  PluginHostResult
} from '../../../shared/plugins/workers/plugin-host-api'
import type { DiscoveredPlugin, ValidDiscoveredPlugin } from '../plugin-discovery'
import { getPluginsDataDir, isInvalidDiscoveredPlugin } from '../plugin-discovery'
import type { PluginService } from '../plugin-service'
import { PluginHostCallError, type PluginHostCallScope } from '../workers/plugin-host-call-scope'
import {
  APPEARANCE_SELECTION_KEYS,
  appearancePaletteRefresh,
  appearanceRevertUpdates,
  followsPluginAppearance,
  recordAppearanceRestore
} from './plugin-appearance-restore'
import {
  appearanceSnapshotFile,
  readAppearanceSnapshot,
  writeAppearanceSnapshot,
  type AppearanceSnapshot
} from './plugin-appearance-snapshot'
import {
  preparePluginAppearanceColors,
  type PreparedPluginAppearance
} from './plugin-appearance-colors'

export type PluginAppearanceSettingsStore = {
  getSettings(): GlobalSettings
  updateSettings(updates: Partial<GlobalSettings>): void
}

type Snapshot = AppearanceSnapshot
type OwnerState = { snapshot: Snapshot; themes: PreparedPluginAppearance[] }

function assertActive(scope: PluginHostCallScope): void {
  scope.assertActive()
  if (scope.signal?.aborted) {
    throw new PluginHostCallError('cancelled', 'appearance update was cancelled')
  }
}

export class PluginAppearanceService {
  // Why random revisions: ABA settings changes must still invalidate stale conditional writes.
  private readonly owners = new Map<string, OwnerState>()
  private revision = randomBytes(32).toString('hex')
  private fingerprint: string | null = null

  constructor(
    private readonly options: {
      pluginsDataDir: string
      settings: PluginAppearanceSettingsStore
      approved: (pluginKey: string) => ValidDiscoveredPlugin | null
      changed: () => void
      warn: (pluginKey: string, message: string) => void
    }
  ) {}

  /** Current conditional-update revision for the desktop appearance selection. */
  read(): PluginHostResult<'appearance.read'> {
    const settings = this.options.settings.getSettings()
    const selection = {
      settings: APPEARANCE_SELECTION_KEYS.map((key) => settings[key]),
      resources: [...this.owners]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => [key, value.snapshot])
    }
    const fingerprint = createHash('sha256').update(JSON.stringify(selection)).digest('hex')
    if (fingerprint !== this.fingerprint) {
      this.fingerprint = fingerprint
      this.revision = randomBytes(32).toString('hex')
    }
    return { revision: this.revision }
  }

  /** Invalidates the revision when the user or another writer changes the selection. */
  settingsChanged(updates: Partial<GlobalSettings>): void {
    if (
      Object.keys(updates).some((key) =>
        APPEARANCE_SELECTION_KEYS.some((selected) => selected === key)
      )
    ) {
      this.fingerprint = null
      this.revision = randomBytes(32).toString('hex')
    }
  }

  /** Validates, persists, and selects one owner's colors; restores the prior snapshot on settings failure. */
  apply(
    pluginKey: string,
    input: PluginHostParams<'appearance.apply'>,
    scope: PluginHostCallScope
  ): PluginHostResult<'appearance.apply'> {
    assertActive(scope)
    const plugin = this.options.approved(pluginKey)
    if (!plugin) {
      throw new PluginHostCallError('consent_required', 'appearance owner is not enabled')
    }
    if (input.expectedRevision !== this.read().revision) {
      throw new PluginHostCallError(
        'conflict',
        'appearance changed; read a new revision before applying'
      )
    }
    const prepared = preparePluginAppearanceColors(
      pluginKey,
      plugin.manifest.name,
      input,
      this.options.settings.getSettings()
    )
    const previous = this.owners.get(pluginKey)
    const current = this.options.settings.getSettings()
    const selected = followsPluginAppearance(
      pluginKey,
      prepared.app.base,
      previous?.snapshot,
      current
    )
    const next: Snapshot = {
      ...(previous?.snapshot ?? { schemaVersion: 1 }),
      [prepared.app.base]: { app: input.app, terminal: input.terminal },
      ...(selected
        ? {
            restore: recordAppearanceRestore(previous?.snapshot.restore, prepared.settings, current)
          }
        : {})
    }
    const updates = selected
      ? prepared.settings
      : appearancePaletteRefresh(prepared.app.id, prepared.settings, current)
    const staged = this.prepare(plugin, next)
    assertActive(scope)
    this.persist(pluginKey, next)
    this.owners.set(pluginKey, staged)
    try {
      if (updates) {
        this.options.settings.updateSettings(updates)
      }
    } catch (error) {
      if (previous) {
        this.owners.set(pluginKey, previous)
      } else {
        this.owners.delete(pluginKey)
      }
      try {
        this.persist(pluginKey, previous?.snapshot ?? { schemaVersion: 1 })
      } catch {
        this.options.warn(
          pluginKey,
          'could not restore the prior persisted appearance after a settings failure'
        )
      }
      throw error
    }
    this.options.changed()
    this.fingerprint = null
    return {
      revision: this.read().revision,
      themeId: prepared.app.id,
      mode: prepared.app.base,
      selected,
      delivery: 'published'
    }
  }

  /**
   * Returns the user's prior selection for keys still holding what this owner wrote, then forgets
   * the owner so re-enabling it starts as a fresh opt-in.
   */
  private revert(pluginKey: string, owner: OwnerState, present: boolean): void {
    this.owners.delete(pluginKey)
    const updates = appearanceRevertUpdates(
      pluginKey,
      owner.snapshot.restore,
      this.options.settings.getSettings()
    )
    try {
      if (Object.keys(updates).length > 0) {
        this.options.settings.updateSettings(updates)
      }
      // Why only when present: an uninstall removes the data folder; do not recreate it.
      if (present && existsSync(this.file(pluginKey))) {
        this.persist(pluginKey, { schemaVersion: 1 })
      }
    } catch (error) {
      this.options.warn(
        pluginKey,
        `could not restore the prior appearance: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  /**
   * Reloads persisted snapshots, then reverts owners that are no longer installed or approved so
   * the user's prior selection returns instead of a silent built-in fallback.
   */
  reconcile(
    discovered: readonly DiscoveredPlugin[],
    isApproved: (plugin: ValidDiscoveredPlugin) => boolean = () => true
  ): void {
    const present = new Set<string>()
    const approved = new Set<string>()
    for (const plugin of discovered) {
      if (isInvalidDiscoveredPlugin(plugin)) {
        continue
      }
      present.add(plugin.pluginKey)
      if (isApproved(plugin)) {
        approved.add(plugin.pluginKey)
      }
      if (this.owners.has(plugin.pluginKey)) {
        continue
      }
      try {
        const stored = readAppearanceSnapshot(this.file(plugin.pluginKey))
        if (stored) {
          this.owners.set(plugin.pluginKey, this.prepare(plugin, stored))
        }
      } catch (error) {
        this.options.warn(plugin.pluginKey, error instanceof Error ? error.message : String(error))
      }
    }
    for (const [key, owner] of this.owners) {
      if (!approved.has(key)) {
        this.revert(key, owner, present.has(key))
      }
    }
  }

  /** App themes owned by approved plugins; unapproved owners stay hidden and fall back to built-ins. */
  readonly overlayAppThemes = (
    entries: readonly PluginThemeRegistration[]
  ): readonly PluginThemeRegistration[] =>
    this.overlay(
      entries,
      this.active().map((theme) => theme.app)
    )

  /** Terminal themes owned by approved plugins; mirrors the app overlay contract. */
  readonly overlayTerminalThemes = (
    entries: readonly PluginTerminalThemeRegistration[]
  ): readonly PluginTerminalThemeRegistration[] =>
    this.overlay(
      entries,
      this.active().map((theme) => theme.terminal)
    )

  private active(): PreparedPluginAppearance[] {
    return [...this.owners].flatMap(([key, owner]) =>
      this.options.approved(key) ? owner.themes : []
    )
  }

  private overlay<T extends { id: string }>(
    entries: readonly T[],
    generated: readonly T[]
  ): readonly T[] {
    const ids = new Set(generated.map((entry) => entry.id))
    return [...entries.filter((entry) => !ids.has(entry.id)), ...generated]
  }

  private prepare(plugin: ValidDiscoveredPlugin, state: Snapshot): OwnerState {
    return {
      snapshot: state,
      themes: [state.dark, state.light].flatMap((entry) =>
        entry
          ? [
              preparePluginAppearanceColors(
                plugin.pluginKey,
                plugin.manifest.name,
                entry,
                this.options.settings.getSettings()
              )
            ]
          : []
      )
    }
  }

  private file(pluginKey: string): string {
    return appearanceSnapshotFile(this.options.pluginsDataDir, pluginKey)
  }

  private persist(pluginKey: string, state: Snapshot): void {
    writeAppearanceSnapshot(this.file(pluginKey), state)
  }
}

/** Wires the appearance service to the desktop settings store and plugin approvals. */
export function createPluginAppearanceService(
  settings: PluginAppearanceSettingsStore,
  userDataPath: string,
  plugins: () => PluginService | null
): PluginAppearanceService {
  return new PluginAppearanceService({
    pluginsDataDir: getPluginsDataDir(userDataPath),
    settings,
    approved: (key) => plugins()?.findApprovedPlugin(key, true) ?? null,
    changed: () => plugins()?.notifyAppearanceChanged(),
    warn: (key, message) => plugins()?.captureLog(key)('warn', message)
  })
}

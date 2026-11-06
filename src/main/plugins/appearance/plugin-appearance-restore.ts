import { z } from 'zod'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { normalizePluginThemeSettings } from '../../../shared/plugin-theme-settings'
import { pluginRuntimeThemeId } from '../../../shared/plugins/appearance/plugin-runtime-theme-id'
import { normalizeTerminalColorOverrides } from '../../../shared/terminal-themes/terminal-custom-themes'

type Mode = 'dark' | 'light'

const slotValue = z.string().max(512).nullable()
const overrides = z.record(z.string().max(64), z.string().max(256)).nullable()
// Why an allowlist: only the selection keys `apply` writes may ever be restored from disk.
const restorableSchema = z.strictObject({
  theme: z.enum(['system', 'dark', 'light']).optional(),
  pluginAppThemeDark: slotValue.optional(),
  pluginAppThemeLight: slotValue.optional(),
  editorThemeDark: slotValue.optional(),
  editorThemeLight: slotValue.optional(),
  terminalThemeDark: z.string().max(512).optional(),
  terminalThemeLight: z.string().max(512).optional(),
  terminalUseSeparateLightTheme: z.boolean().optional(),
  terminalColorOverrides: overrides.optional(),
  terminalColorOverridesLight: overrides.optional()
})
type RestorableKey = keyof z.infer<typeof restorableSchema>

function isRestorableKey(key: string): key is RestorableKey {
  return key in restorableSchema.shape
}

const RESTORABLE_KEYS = Object.keys(restorableSchema.shape).filter(isRestorableKey)

/** Settings whose change invalidates an appearance revision: every restorable key plus palettes. */
export const APPEARANCE_SELECTION_KEYS = [
  ...RESTORABLE_KEYS,
  'terminalPluginPalettes'
] as const satisfies readonly (keyof GlobalSettings)[]

/** User selection before an owner first took each key, and what the owner last wrote. */
export const appearanceRestoreSchema = z.strictObject({
  prior: restorableSchema,
  written: restorableSchema
})
export type AppearanceRestore = z.infer<typeof appearanceRestoreSchema>

// Why null: JSON drops undefined, and an absent override bag must still round-trip.
function stored(value: unknown): unknown {
  return value === undefined ? null : value
}

/**
 * Whether a publish may select itself. The first publish opts the user in; afterwards the owner
 * only re-selects a mode whose slot still shows its colors, so picking another theme in
 * Appearance settings stops the sync until the user picks the dynamic option again.
 */
export function followsPluginAppearance(
  pluginKey: string,
  base: Mode,
  published: Partial<Record<Mode, unknown>> | undefined,
  settings: GlobalSettings
): boolean {
  const slot = (mode: Mode) =>
    mode === 'dark' ? settings.pluginAppThemeDark : settings.pluginAppThemeLight
  if (published?.[base]) {
    return slot(base) === pluginRuntimeThemeId(pluginKey, base)
  }
  const other = base === 'dark' ? 'light' : 'dark'
  return !published?.[other] || slot(other) === pluginRuntimeThemeId(pluginKey, other)
}

/** Remembers each key's pre-plugin value once, and the owner's latest write for every key. */
export function recordAppearanceRestore(
  existing: AppearanceRestore | undefined,
  updates: Partial<GlobalSettings>,
  settings: GlobalSettings
): AppearanceRestore {
  const prior: Record<string, unknown> = { ...existing?.prior }
  const written: Record<string, unknown> = { ...existing?.written }
  for (const key of RESTORABLE_KEYS) {
    if (!(key in updates)) {
      continue
    }
    if (!(key in prior)) {
      prior[key] = stored(settings[key])
    }
    written[key] = stored(updates[key])
  }
  return appearanceRestoreSchema.parse({ prior, written })
}

/** An unselected publish still repaints a terminal that picked the owner's palette directly. */
export function appearancePaletteRefresh(
  id: string,
  updates: Partial<GlobalSettings>,
  settings: GlobalSettings
): Partial<GlobalSettings> | null {
  const palettes = settings.terminalPluginPalettes ?? []
  const fresh = updates.terminalPluginPalettes?.find((entry) => entry.id === id)
  if (!fresh || !palettes.some((entry) => entry.id === id)) {
    return null
  }
  return { terminalPluginPalettes: palettes.map((entry) => (entry.id === id ? fresh : entry)) }
}

/** The settings write returning the user's prior selection for keys still holding the owner's. */
export function appearanceRevertUpdates(
  pluginKey: string,
  restore: AppearanceRestore | undefined,
  settings: GlobalSettings
): Partial<GlobalSettings> {
  const keys = restore
    ? RESTORABLE_KEYS.filter(
        (key) =>
          key in restore.prior &&
          key in restore.written &&
          JSON.stringify(stored(settings[key])) === JSON.stringify(restore.written[key])
      )
    : []
  const picked = restorableSchema.parse(
    Object.fromEntries(keys.map((key) => [key, restore?.prior[key]]))
  )
  const {
    pluginAppThemeDark,
    pluginAppThemeLight,
    editorThemeDark,
    editorThemeLight,
    terminalColorOverrides,
    terminalColorOverridesLight,
    ...plain
  } = picked
  const slots = Object.fromEntries(
    Object.entries({
      pluginAppThemeDark,
      pluginAppThemeLight,
      editorThemeDark,
      editorThemeLight
    }).filter(([key]) => key in picked)
  )
  const bag = (value: Record<string, string> | null | undefined) =>
    value ? normalizeTerminalColorOverrides(value) : undefined
  const updates: Partial<GlobalSettings> = {
    ...plain,
    ...normalizePluginThemeSettings(slots),
    ...('terminalColorOverrides' in picked
      ? { terminalColorOverrides: bag(terminalColorOverrides) }
      : {}),
    ...('terminalColorOverridesLight' in picked
      ? { terminalColorOverridesLight: bag(terminalColorOverridesLight) }
      : {})
  }
  const ids = new Set<string>([
    pluginRuntimeThemeId(pluginKey, 'dark'),
    pluginRuntimeThemeId(pluginKey, 'light')
  ])
  const palettes = settings.terminalPluginPalettes ?? []
  if (palettes.some((entry) => ids.has(entry.id))) {
    updates.terminalPluginPalettes = palettes.filter((entry) => !ids.has(entry.id))
  }
  return updates
}

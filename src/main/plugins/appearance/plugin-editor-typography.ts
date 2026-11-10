import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { PersistedUIState } from '../../../shared/persisted-ui-state-types'
import type { PluginEventName } from '../../../shared/plugins/manifest/plugin-manifest'
import {
  resolvePluginEditorTypography,
  type PluginEditorTypography
} from '../../../shared/plugins/workers/plugin-host-api-editor-typography'

/** What `editor.readTypography` reads: this Orca's own profile, never a remote host's. */
export type PluginEditorTypographySource = {
  read(): PluginEditorTypography
}

type EditorTypographyStore = {
  getSettings(): GlobalSettings
  getUI(): Pick<PersistedUIState, 'editorFontZoomLevel'>
  onSettingsChanged(
    listener: (updates: Partial<GlobalSettings>, settings: GlobalSettings) => void
  ): () => void
  onUIChanged(listener: (ui: Pick<PersistedUIState, 'editorFontZoomLevel'>) => void): () => void
}

type PluginEvents = {
  emitEvent(event: PluginEventName, payload: unknown): void
  wantsEvent(event: PluginEventName): boolean
}

export function createPluginEditorTypographySource(
  store: Pick<EditorTypographyStore, 'getSettings' | 'getUI'>
): PluginEditorTypographySource {
  return {
    read: () =>
      resolvePluginEditorTypography(store.getSettings(), store.getUI().editorFontZoomLevel)
  }
}

/** The source `editor.readTypography` reads, with `editor.typography.changed` emitted to `events`. */
export function bindPluginEditorTypography(
  store: EditorTypographyStore,
  events: () => PluginEvents | null
): PluginEditorTypographySource {
  watchPluginEditorTypography({ store, events })
  return createPluginEditorTypographySource(store)
}

/**
 * `editor.typography.changed`: after a settings write or an editor zoom, emit when what the file
 * editor resolves differs from before. Why track it while nobody listens: a listener that joins
 * must hear the next real change, and must not hear a change that happened before it read.
 */
export function watchPluginEditorTypography(input: {
  store: EditorTypographyStore
  /** Null until the plugin service exists. */
  events: () => PluginEvents | null
}): () => void {
  const { store } = input
  const source = createPluginEditorTypographySource(store)
  let zoom = store.getUI().editorFontZoomLevel
  let last: string | null = null
  // Why guarded: these run inside settings and startup paths that must never fail for a plugin event.
  const resolve = (): { typography: PluginEditorTypography; signature: string } | null => {
    try {
      const typography = source.read()
      return { typography, signature: JSON.stringify(typography) }
    } catch (error) {
      console.warn('[plugins] failed to resolve editor typography:', error)
      return null
    }
  }
  last = resolve()?.signature ?? null
  // Why read live, not from the listener: silent settings writes must not leave the payload stale.
  const check = (): void => {
    const next = resolve()
    if (!next || next.signature === last) {
      return
    }
    last = next.signature
    const events = input.events()
    if (events?.wantsEvent('editor.typography.changed')) {
      events.emitEvent('editor.typography.changed', next.typography)
    }
  }
  const stopSettings = store.onSettingsChanged(() => check())
  // Why compare the zoom first: UI writes (sidebar widths, focus) are frequent and rarely zoom.
  const stopUI = store.onUIChanged((ui) => {
    if (Object.is(ui.editorFontZoomLevel, zoom)) {
      return
    }
    zoom = ui.editorFontZoomLevel
    check()
  })
  return () => {
    stopSettings()
    stopUI()
  }
}

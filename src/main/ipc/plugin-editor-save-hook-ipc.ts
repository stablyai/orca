import { ipcMain } from 'electron'
import { PLUGIN_HOOK_SPECS } from '../../shared/plugins/events/plugin-hook-payloads'
import type { EditorSaveHookDecision } from '../../shared/plugins/events/plugin-editor-save-hook'
import { PluginHookDeniedError, runPluginHook } from '../plugins/hooks/plugin-hook-dispatch'

/**
 * `editor.save.before` for the window's editor: the renderer asks only when a live plugin lists
 * the hook, and writes what this answers. SSH, WSL and folder files all save through that one
 * renderer path, so they are decided here, on the desktop, before the write leaves it.
 */
export function registerPluginEditorSaveHookHandler(): void {
  ipcMain.handle(
    'plugins:editorSaveHook',
    async (_event, payload: unknown): Promise<EditorSaveHookDecision> => {
      const schema = PLUGIN_HOOK_SPECS['editor.save.before'].payload
      const parsed = schema.safeParse(payload)
      if (!parsed.success) {
        // Why pass: a buffer the hook cannot carry (say, too large) saves as Orca would without it.
        return { kind: 'continue', text: null }
      }
      try {
        const decided = await runPluginHook('editor.save.before', schema, parsed.data)
        return { kind: 'continue', text: decided.text }
      } catch (error) {
        if (error instanceof PluginHookDeniedError) {
          return { kind: 'deny', pluginKey: error.pluginKey, reason: error.reason }
        }
        throw error
      }
    }
  )
}

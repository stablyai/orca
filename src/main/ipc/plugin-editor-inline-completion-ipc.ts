import { ipcMain } from 'electron'
import { PLUGIN_HOOK_SPECS } from '../../shared/plugins/events/plugin-hook-payloads'
import { runPluginHook } from '../plugins/hooks/plugin-hook-dispatch'

/**
 * `editor.inlineCompletion` for the window's editor: the renderer asks only when a live plugin
 * lists the hook and shows what this answers as ghost text. Decided on the desktop so SSH, WSL and
 * folder files take the same path.
 */
export function registerPluginEditorInlineCompletionHandler(): void {
  ipcMain.handle(
    'plugins:editorInlineCompletion',
    async (_event, payload: unknown): Promise<{ suggestion: string }> => {
      const schema = PLUGIN_HOOK_SPECS['editor.inlineCompletion'].payload
      const parsed = schema.safeParse(payload)
      if (!parsed.success) {
        return { suggestion: '' }
      }
      try {
        const decided = await runPluginHook('editor.inlineCompletion', schema, parsed.data)
        return { suggestion: decided.suggestion }
      } catch {
        // Why: a failing plugin chain must not reject the invoke on every typing pause.
        return { suggestion: '' }
      }
    }
  )
}

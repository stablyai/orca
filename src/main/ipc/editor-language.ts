import { ipcMain } from 'electron'
import type {
  EditorLanguageDefinitionResult,
  EditorLanguageRequest
} from '../../shared/editor-language-types'
import type { Store } from '../persistence'
import { resolveAuthorizedPath } from './filesystem-auth'
import { getTypeScriptDefinition } from '../editor-language/typescript-language-service'

async function authorizeEditorLanguageRequest(
  store: Store,
  request: EditorLanguageRequest
): Promise<EditorLanguageRequest> {
  const [rootPath, filePath] = await Promise.all([
    resolveAuthorizedPath(request.rootPath, store),
    resolveAuthorizedPath(request.filePath, store)
  ])
  return { ...request, rootPath, filePath }
}

export function registerEditorLanguageHandlers(store: Store): void {
  ipcMain.handle(
    'editorLanguage:getDefinition',
    async (
      _event,
      request: EditorLanguageRequest
    ): Promise<EditorLanguageDefinitionResult | null> => {
      return getTypeScriptDefinition(await authorizeEditorLanguageRequest(store, request))
    }
  )
}

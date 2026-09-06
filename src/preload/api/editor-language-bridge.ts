import { ipcRenderer } from 'electron'
import type {
  EditorLanguageDefinitionResult,
  EditorLanguageRequest
} from '../../shared/editor-language-types'
import type { PreloadApi } from '../api-types'

export const editorLanguageApi = {
  getDefinition: (args: EditorLanguageRequest): Promise<EditorLanguageDefinitionResult | null> =>
    ipcRenderer.invoke('editorLanguage:getDefinition', args)
} satisfies PreloadApi['editorLanguage']

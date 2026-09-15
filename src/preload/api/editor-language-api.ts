import type {
  EditorLanguageDefinitionResult,
  EditorLanguageRequest
} from '../../shared/editor-language-types'

export type EditorLanguageApi = {
  editorLanguage: {
    getDefinition: (args: EditorLanguageRequest) => Promise<EditorLanguageDefinitionResult | null>
  }
}

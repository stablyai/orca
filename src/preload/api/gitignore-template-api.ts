import type {
  GitignoreTemplateCatalogResult,
  GitignoreTemplateResult
} from '../../shared/gitignore-templates'

export type GitignoreTemplateApi = {
  gitignoreTemplates: {
    list: () => Promise<GitignoreTemplateCatalogResult>
    get: (name: string) => Promise<GitignoreTemplateResult>
  }
}

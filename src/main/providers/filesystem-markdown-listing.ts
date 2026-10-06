import type { IFilesystemProvider } from './types'
import { markdownDocumentsFromRelativePaths } from '../../shared/markdown-document-paths'
import { FileInventoryBudget } from '../../shared/file-inventory-budget'

export async function listFilesystemMarkdownDocuments(
  provider: IFilesystemProvider,
  rootPath: string
) {
  if (provider.listMarkdownDocuments) {
    return provider.listMarkdownDocuments(rootPath)
  }
  const paths = await provider.listFiles(rootPath)
  const budget = new FileInventoryBudget()
  for (const path of paths) {
    budget.record(path)
  }
  return markdownDocumentsFromRelativePaths(rootPath, paths)
}

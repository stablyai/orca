import type { IFilesystemProvider } from './filesystem-provider-contract'
import { markdownDocumentsFromRelativePaths } from '../../shared/markdown-document-paths'
import { FileInventoryBudget } from '../../shared/file-inventory-budget'

type MarkdownListingProvider =
  | Required<Pick<IFilesystemProvider, 'listMarkdownDocuments'>>
  | Pick<IFilesystemProvider, 'listMarkdownDocuments' | 'listFiles'>

function hasMarkdownListing(
  provider: MarkdownListingProvider
): provider is Required<Pick<IFilesystemProvider, 'listMarkdownDocuments'>> {
  return Boolean(provider.listMarkdownDocuments)
}

export async function listFilesystemMarkdownDocuments(
  provider: MarkdownListingProvider,
  rootPath: string
) {
  if (hasMarkdownListing(provider)) {
    return provider.listMarkdownDocuments(rootPath)
  }
  const paths = await provider.listFiles(rootPath)
  const budget = new FileInventoryBudget()
  for (const path of paths) {
    budget.record(path)
  }
  return markdownDocumentsFromRelativePaths(rootPath, paths)
}

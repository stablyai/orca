export type FilesystemPathListingProvider = {
  listFiles(
    rootPath: string,
    options?: { excludePaths?: string[]; signal?: AbortSignal; maxResults?: number }
  ): Promise<string[]>
  listMarkdownDocuments?(rootPath: string): Promise<string[]>
}

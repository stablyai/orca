// File-path -> LSP languageId resolution for the clangd session's didOpen.
// Extracted so the session module stays under its line budget (AGENTS.md:
// no max-lines disables — split to a sibling when a file approaches 300).
const LSP_LANGUAGE_BY_EXTENSION: Record<string, string> = {
  '.c': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.c++': 'cpp',
  '.hpp': 'cpp',
  '.hh': 'cpp',
  '.h': 'cpp',
  '.hxx': 'cpp',
  '.inl': 'cpp',
  '.m': 'objective-c',
  '.mm': 'objective-cpp'
}

/** The LSP languageId clangd should parse the file as (default cpp). */
export function lspLanguageForFile(filePath: string): string {
  const dot = filePath.lastIndexOf('.')
  if (dot === -1) {
    return 'cpp'
  }
  return LSP_LANGUAGE_BY_EXTENSION[filePath.slice(dot).toLowerCase()] ?? 'cpp'
}

function extname(filePath: string): string {
  const lastDot = filePath.lastIndexOf('.')
  const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  if (lastDot <= lastSlash) {
    return ''
  }
  return filePath.slice(lastDot)
}

const EXT_TO_LANGUAGE: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.json': 'json',
  '.jsonc': 'json',
  '.md': 'markdown',
  '.mdx': 'markdown',
  '.css': 'css',
  '.scss': 'scss',
  '.less': 'less',
  '.html': 'html',
  '.htm': 'html',
  '.xml': 'xml',
  '.svg': 'xml',
  '.py': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.java': 'java',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.cs': 'csharp',
  '.rb': 'ruby',
  '.php': 'php',
  '.swift': 'swift',
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
  '.fish': 'shell',
  '.ps1': 'powershell',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'ini',
  '.ini': 'ini',
  '.cfg': 'ini',
  '.conf': 'ini',
  '.sql': 'sql',
  '.graphql': 'graphql',
  '.gql': 'graphql',
  '.lua': 'lua',
  '.r': 'r',
  '.R': 'r',
  '.make': 'makefile'
}

const FILENAME_TO_LANGUAGE: Record<string, string> = {
  Dockerfile: 'dockerfile',
  Makefile: 'makefile',
  'CMakeLists.txt': 'cmake',
  '.gitignore': 'ini',
  '.gitattributes': 'ini',
  '.editorconfig': 'ini',
  '.env': 'ini',
  '.env.local': 'ini',
  '.env.development': 'ini',
  '.env.production': 'ini'
}

export function detectMobileFileLanguage(filePath: string, preferredLanguage?: string): string {
  const normalizedPreferred = preferredLanguage?.trim().toLowerCase()
  if (normalizedPreferred && normalizedPreferred !== 'plaintext') {
    return normalizedPreferred
  }

  const parts = filePath.split(/[\\/]/)
  const filename = parts.at(-1) ?? filePath
  const exact = FILENAME_TO_LANGUAGE[filename]
  if (exact) {
    return exact
  }

  return EXT_TO_LANGUAGE[extname(filename).toLowerCase()] ?? 'plaintext'
}

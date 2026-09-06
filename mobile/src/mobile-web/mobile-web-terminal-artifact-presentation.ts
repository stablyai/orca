const RASTER_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico'])

export function terminalArtifactPreviewKind(path: string): 'text' | 'raster' {
  const displayName = displayNameFromTerminalArtifactPath(path)
  const extension = displayName.includes('.') ? displayName.split('.').at(-1)?.toLowerCase() : ''
  return extension && RASTER_EXTENSIONS.has(extension) ? 'raster' : 'text'
}

export function displayNameFromTerminalArtifactPath(path: string): string {
  const basename = path.split(/[\\/]/).at(-1) ?? ''
  const sanitized = [...basename]
    .filter((character) => {
      const code = character.charCodeAt(0)
      return code >= 32 && code !== 127 && character !== '/' && character !== '\\'
    })
    .join('')
    .slice(-255)
  return sanitized || 'Terminal artifact'
}

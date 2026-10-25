export function mobilePdfHandoffMime(path: string): string | null {
  const name = path.split(/[/\\]/).pop() ?? ''
  const dot = name.lastIndexOf('.')
  if (dot <= 0) {
    return null
  }
  return name.slice(dot).toLowerCase() === '.pdf' ? 'application/pdf' : null
}

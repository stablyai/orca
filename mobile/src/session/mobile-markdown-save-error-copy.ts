export function mobileMarkdownSaveErrorCopy(error: unknown): string {
  const code = error instanceof Error ? error.message : ''
  if (code === 'conflict') {
    return 'Changed on desktop'
  }
  if (code === 'not_connected') {
    return 'Desktop is offline'
  }
  if (code === 'too_large') {
    return 'Too large to save'
  }
  return 'Save failed'
}

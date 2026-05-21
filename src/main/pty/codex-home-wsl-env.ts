export function isHostCodexHomeForWsl(value: string | undefined): boolean {
  const trimmed = value?.trim()
  if (!trimmed) {
    return false
  }
  return /^[A-Za-z]:(?:[\\/]|$)/.test(trimmed) || trimmed.startsWith('\\\\')
}

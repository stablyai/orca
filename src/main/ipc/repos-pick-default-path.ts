// Why: omitting defaultPath preserves the native dialog's last-used location
// when a caller has no project-specific starting directory.
export function resolvePickerDefaultPath(path: string | undefined): string | undefined {
  return path?.trim() || undefined
}

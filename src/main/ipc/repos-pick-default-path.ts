// Resolves the effective defaultPath for a project/repo folder picker.
// Explicit arg wins over the saved global setting; an empty/absent value
// yields undefined so the dialog keeps the OS last-used location.
export function resolvePickerDefaultPath(
  argPath: string | undefined,
  settingPath: string | undefined
): string | undefined {
  const candidate = argPath?.trim() || settingPath?.trim()
  return candidate ? candidate : undefined
}

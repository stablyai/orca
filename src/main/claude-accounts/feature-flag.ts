type FlagSubset = { claudeMultiProviderEnabled?: boolean }

export function isMultiProviderEnabled(settings: FlagSubset): boolean {
  return settings.claudeMultiProviderEnabled === true
}

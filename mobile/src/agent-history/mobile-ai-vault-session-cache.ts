const mobileAiVaultMemoryCache = new Map<string, unknown>()

export function clearMobileAiVaultMemoryCache(): void {
  mobileAiVaultMemoryCache.clear()
}

// Zero-dependency registry so runtime construction and lazy IPC registration can configure
// AI Vault session sources without eagerly importing scanner modules at startup.
export type AiVaultSessionSources = {
  getAdditionalCodexHomePaths?: () => readonly string[]
}

let sources: AiVaultSessionSources = {}

export function configureAiVaultSessionSources(next: AiVaultSessionSources): void {
  sources = next
}

export function getAiVaultSessionSources(): AiVaultSessionSources {
  return sources
}

export function resetAiVaultSessionSourcesForTests(): void {
  sources = {}
}

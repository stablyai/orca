import type { Store } from '../persistence/loading-store/store'
import type { agentHookServer as hookServer } from '../agent-hooks/server/agent-hook-server'
import type { BackendServiceCleanup } from './service-composition'

export async function prepareBackendAccountHomes(
  profileStore: Store,
  registerCleanup: (cleanup: BackendServiceCleanup) => void
) {
  const { orcadCodexAccountHomes } =
    await import('../orcad/account-launch/orcad-codex-account-homes')
  return {
    codexAccountHomes: orcadCodexAccountHomes(() => profileStore.getSettings(), registerCleanup)
  }
}

export async function prepareBackendAccounts(
  profileStore: Store,
  agentHookServer: Pick<typeof hookServer, 'setClaudeStatusLineListener'>,
  codexAccountHomes: Awaited<ReturnType<typeof prepareBackendAccountHomes>>['codexAccountHomes'],
  registerCleanup: (cleanup: BackendServiceCleanup) => void
) {
  const { createOrcadAccountServices } =
    await import('../orcad/account-launch/orcad-account-services')
  return createOrcadAccountServices({
    store: profileStore,
    setClaudeStatusLineListener: (listener) =>
      agentHookServer.setClaudeStatusLineListener(listener),
    registerCleanup,
    clientCodexHomes: codexAccountHomes
  })
}

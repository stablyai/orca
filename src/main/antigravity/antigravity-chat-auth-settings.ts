import {
  resolveAntigravityChatAuthConfig,
  AntigravityChatAuthConfigSchema,
  type AntigravityChatAuthConfig
} from '../../shared/antigravity-chat-auth-config'
import type { RuntimeStore } from '../runtime/runtime-store-contract'
import { agentModelCatalogStore } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import { ANTIGRAVITY_LAUNCH_GATE, antigravityChatSignIn } from './antigravity-chat-account'

type AuthStore = Pick<RuntimeStore, 'getSettings' | 'updateSettingsAndFlush'>

export function readAntigravityChatAuthConfig(store: AuthStore): AntigravityChatAuthConfig | null {
  const read = ANTIGRAVITY_LAUNCH_GATE.enter(undefined)
  try {
    const value = store.getSettings().antigravityChatAuth
    if (value === undefined) {
      return { method: 'oauth-personal' }
    }
    const parsed = AntigravityChatAuthConfigSchema.safeParse(value)
    return parsed.success ? parsed.data : null
  } finally {
    read.leave()
  }
}

export function applyAntigravityChatAuthConfig(
  store: AuthStore,
  value: unknown,
  stopLiveChats: () => Promise<void>
): Promise<AntigravityChatAuthConfig> {
  const next = resolveAntigravityChatAuthConfig(value)
  const read = ANTIGRAVITY_LAUNCH_GATE.enter(undefined)
  let unchanged: boolean
  try {
    // A malformed saved choice must still be repairable from Account settings.
    const previous = AntigravityChatAuthConfigSchema.safeParse(
      store.getSettings().antigravityChatAuth ?? { method: 'oauth-personal' }
    )
    unchanged = previous.success && JSON.stringify(previous.data) === JSON.stringify(next)
  } finally {
    read.leave()
  }
  if (unchanged) {
    return Promise.resolve(next)
  }
  if (!store.updateSettingsAndFlush) {
    throw new Error(
      'Antigravity account settings cannot be saved on this host. Update Orca and try again.'
    )
  }
  const flush = store.updateSettingsAndFlush.bind(store)
  return ANTIGRAVITY_LAUNCH_GATE.run(stopLiveChats, async () => {
    await flush({ antigravityChatAuth: next }, { notifyListeners: true })
    antigravityChatSignIn.set({ auth: 'unknown', flow: null })
    agentModelCatalogStore.expireAgent('antigravity')
    return next
  })
}

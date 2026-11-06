import {
  resolveAntigravityChatAuthConfig,
  AntigravityChatAuthConfigSchema,
  type AntigravityChatAuthConfig
} from '../../shared/antigravity-chat-auth-config'
import type { RuntimeStore } from '../runtime/runtime-store-contract'
import { agentModelCatalogStore } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import { ANTIGRAVITY_LAUNCH_GATE, antigravityChatSignIn } from './antigravity-chat-account'
import {
  assertAntigravityChatAuthPublished,
  publishAntigravityChatAuth
} from './antigravity-chat-auth-publication'

type AuthStore = Pick<RuntimeStore, 'getSettings' | 'updateSettingsAndFlush' | 'updateSettings'>

export function readAntigravityChatAuthConfig(store: AuthStore): AntigravityChatAuthConfig | null {
  const value = store.getSettings().antigravityChatAuth
  assertAntigravityChatAuthPublished(value)
  if (value === undefined) {
    return { method: 'oauth-personal' }
  }
  const parsed = AntigravityChatAuthConfigSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

export function applyAntigravityChatAuthConfig(
  store: AuthStore,
  value: unknown,
  stopLiveChats: () => Promise<void>
): Promise<AntigravityChatAuthConfig> {
  const next = { ...resolveAntigravityChatAuthConfig(value) }
  const read = ANTIGRAVITY_LAUNCH_GATE.enter(undefined)
  let unchanged: boolean
  try {
    // A malformed saved choice must still be repairable from Account settings.
    const value = store.getSettings().antigravityChatAuth
    assertAntigravityChatAuthPublished(value)
    const previous = AntigravityChatAuthConfigSchema.safeParse(
      value === undefined ? { method: 'oauth-personal' } : value
    )
    unchanged = previous.success && JSON.stringify(previous.data) === JSON.stringify(next)
  } finally {
    read.leave()
  }
  if (unchanged) {
    return Promise.resolve(next)
  }
  if (!store.updateSettingsAndFlush || !store.updateSettings) {
    throw new Error(
      'Antigravity account settings cannot be saved on this host. Update Orca and try again.'
    )
  }
  const flush = store.updateSettingsAndFlush.bind(store)
  const restore = store.updateSettings.bind(store)
  return ANTIGRAVITY_LAUNCH_GATE.run(stopLiveChats, () => {
    const previous = store.getSettings().antigravityChatAuth
    return publishAntigravityChatAuth(next, async () => {
      try {
        await flush({ antigravityChatAuth: next }, { notifyListeners: true })
      } catch (error) {
        if (store.getSettings().antigravityChatAuth === next) {
          restore({ antigravityChatAuth: previous })
        }
        throw error
      }
      antigravityChatSignIn.set({ auth: 'unknown', flow: null })
      agentModelCatalogStore.expireAgent('antigravity')
      return next
    })
  })
}

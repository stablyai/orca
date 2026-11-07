import {
  AntigravityChatAuthConfigError,
  type AntigravityChatAuthConfig
} from '../../shared/antigravity-chat-auth-config'

const saving = new WeakSet<object>()

export function assertAntigravityChatAuthPublished(value: unknown): void {
  if (value !== null && typeof value === 'object' && saving.has(value)) {
    throw new AntigravityChatAuthConfigError(
      'Antigravity account settings are being saved on this host. Try again after it finishes.'
    )
  }
}

export async function publishAntigravityChatAuth<T>(
  candidate: AntigravityChatAuthConfig,
  commit: () => Promise<T>
): Promise<T> {
  saving.add(candidate)
  try {
    return await commit()
  } finally {
    saving.delete(candidate)
  }
}

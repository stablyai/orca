import {
  AntigravityChatAuthConfigError,
  AntigravityChatAuthUnconfirmedError,
  type AntigravityChatAuthConfig
} from '../../shared/antigravity-chat-auth-config'

const publications = new WeakMap<object, 'saving' | 'unconfirmed'>()

export function assertAntigravityChatAuthPublished(value: unknown): void {
  const state = value !== null && typeof value === 'object' ? publications.get(value) : undefined
  if (state === 'unconfirmed') {
    throw new AntigravityChatAuthUnconfirmedError()
  }
  if (state === 'saving') {
    throw new AntigravityChatAuthConfigError(
      'Antigravity account settings are being saved on this host. Try again after it finishes.'
    )
  }
}

/** The Store retains the exact candidate on an uncertain write; rollback restores its predecessor. */
export async function publishAntigravityChatAuth<T>(
  candidate: AntigravityChatAuthConfig,
  commit: () => Promise<T>
): Promise<T> {
  publications.set(candidate, 'saving')
  try {
    const result = await commit()
    publications.delete(candidate)
    return result
  } catch (error) {
    publications.set(candidate, 'unconfirmed')
    throw error
  }
}

import { AntigravityChatAuthConfigError } from '../../shared/antigravity-chat-auth-config'

const publications = new WeakMap<object, 'saving' | 'unconfirmed'>()

export function assertAntigravityChatAuthPublished(value: unknown): void {
  const state = value !== null && typeof value === 'object' ? publications.get(value) : undefined
  if (state) {
    throw new AntigravityChatAuthConfigError(
      state === 'saving'
        ? 'Antigravity account settings are being saved on this host. Try again after it finishes.'
        : 'Antigravity account settings could not be confirmed on this host. Restart Orca on this host, then try again.'
    )
  }
}

/** The Store retains the exact candidate on an uncertain write; rollback restores its predecessor. */
export async function publishAntigravityChatAuth<T>(
  candidate: object,
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

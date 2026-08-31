import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { parseAppSshPtyId } from '../../shared/ssh-pty-id'

export function createSshIdentityVisibilityPublisher(
  mux: SshChannelMultiplexer,
  connectionId: string
): { set: (ids: string[]) => void; dispose: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending: string[] | null = null
  return {
    set(ids) {
      const relayIds = ids.flatMap((id) => {
        const parsed = parseAppSshPtyId(id)
        return parsed?.connectionId === connectionId ? [parsed.relayPtyId] : []
      })
      pending = Array.from(new Set(relayIds)).slice(0, 512)
      if (timer !== null) {
        return
      }
      timer = setTimeout(() => {
        timer = null
        const next = pending
        pending = null
        if (next) {
          void mux.request('pty.identityEvidence.setVisibility', { ids: next }).catch(() => {})
        }
      }, 50)
      timer.unref?.()
    },
    dispose() {
      if (timer !== null) {
        clearTimeout(timer)
      }
      timer = null
      pending = null
    }
  }
}

// IPC for teammate profiles and Pokes (registered with the other cloud workspace handlers).
import { z } from 'zod'
import type { CloudWorkspacesService } from '../cloud-workspaces/cloud-workspaces-service'

const MemberId = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/)
const NOT_CONFIGURED = { ok: false as const, error: 'not_configured' }
const INVALID = { ok: false as const, error: 'invalid_request' }

export function registerTeamPresenceHandlers(
  handle: (channel: string, fn: (args: unknown) => unknown) => void,
  getService: () => Promise<CloudWorkspacesService | null>
): void {
  handle('cloudWorkspaces:teammateProfile', async (args) => {
    const parsed = z
      .object({ userId: MemberId, utcOffsetMin: z.number().int().min(-840).max(840) })
      .safeParse(args)
    const s = await getService()
    return !s
      ? NOT_CONFIGURED
      : parsed.success
        ? s.teammateProfile(parsed.data.userId, parsed.data.utcOffsetMin)
        : INVALID
  })
  handle('cloudWorkspaces:poke', async (args) => {
    const parsed = z.object({ userId: MemberId }).safeParse(args)
    const s = await getService()
    return !s ? NOT_CONFIGURED : parsed.success ? s.poke(parsed.data.userId) : INVALID
  })
  handle(
    'cloudWorkspaces:pokeInbox',
    async () => (await getService())?.pokeInbox() ?? NOT_CONFIGURED
  )
  handle('cloudWorkspaces:setPokesEnabled', async (args) => {
    const parsed = z.object({ enabled: z.boolean() }).safeParse(args)
    const s = await getService()
    return !s ? NOT_CONFIGURED : parsed.success ? s.setPokesEnabled(parsed.data.enabled) : INVALID
  })
  handle('cloudWorkspaces:markPokesSeen', async (args) => {
    const parsed = z
      .object({
        ids: z
          .array(z.string().regex(/^pok_[0-9a-f]{24}$/))
          .min(1)
          .max(50)
      })
      .safeParse(args)
    const s = await getService()
    return !s ? NOT_CONFIGURED : parsed.success ? s.markPokesSeen(parsed.data.ids) : INVALID
  })
}

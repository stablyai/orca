// IPC for owner changes, registered with the other cloud workspace handlers.
import { z } from 'zod'
import type { CloudWorkspacesService } from '../cloud-workspaces/cloud-workspaces-service'

const MemberId = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/)
const SandboxId = z.string().min(1).max(128)
const NOT_CONFIGURED = { ok: false as const, error: 'not_configured' }
const INVALID = { ok: false as const, error: 'invalid_request' }

export function registerOwnerChangeHandlers(
  handle: (channel: string, fn: (args: unknown) => unknown) => void,
  getService: () => Promise<CloudWorkspacesService | null>
): void {
  handle('cloudWorkspaces:changeOwner', async (args) => {
    const parsed = z.object({ id: SandboxId, ownerUserId: MemberId }).safeParse(args)
    const s = await getService()
    return !s
      ? NOT_CONFIGURED
      : parsed.success
        ? s.changeOwner(parsed.data.id, parsed.data.ownerUserId)
        : INVALID
  })
  handle(
    'cloudWorkspaces:ownerNotices',
    async () => (await getService())?.ownerNotices() ?? NOT_CONFIGURED
  )
  handle('cloudWorkspaces:dismissOwnerNotice', async (args) => {
    const parsed = z.object({ id: z.string().regex(/^[A-Za-z0-9_]{1,64}$/) }).safeParse(args)
    const s = await getService()
    return !s ? NOT_CONFIGURED : parsed.success ? s.dismissOwnerNotice(parsed.data.id) : INVALID
  })
}

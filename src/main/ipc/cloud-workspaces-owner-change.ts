// IPC for owner changes, registered with the other cloud workspace handlers.
import { z } from 'zod'
import type { ServeCloudWorkspaces } from './cloud-workspaces'

const MemberId = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/)
const SandboxId = z.string().min(1).max(128)

export function registerOwnerChangeHandlers(serve: ServeCloudWorkspaces): void {
  serve(
    'cloudWorkspaces:changeOwner',
    z.object({ id: SandboxId, ownerUserId: MemberId }),
    (s, { id, ownerUserId }) => s.changeOwner(id, ownerUserId)
  )
  serve('cloudWorkspaces:ownerNotices', z.unknown(), (s) => s.ownerNotices())
  serve(
    'cloudWorkspaces:dismissOwnerNotice',
    z.object({ id: z.string().regex(/^[A-Za-z0-9_]{1,64}$/) }),
    (s, { id }) => s.dismissOwnerNotice(id)
  )
}

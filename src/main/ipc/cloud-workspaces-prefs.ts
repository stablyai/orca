// IPC for synced cloud workspace prefs (pins, order, sections) and the org's link slug.
// Registered with the other cloud workspace handlers; same `not_configured` contract.
import { z } from 'zod'
import { CloudWorkspacePrefsDocumentSchema } from '../../shared/cloud-workspaces/cloud-workspaces-wire'
import type { CloudWorkspacesService } from '../cloud-workspaces/cloud-workspaces-service'

const NOT_CONFIGURED = { ok: false as const, error: 'not_configured' }
const INVALID = { ok: false as const, error: 'invalid_request' }

export function registerCloudWorkspacePrefsHandlers(
  handle: (channel: string, fn: (args: unknown) => unknown) => void,
  getService: () => Promise<CloudWorkspacesService | null>
): void {
  handle('cloudWorkspaces:getPrefs', async () => (await getService())?.getPrefs() ?? NOT_CONFIGURED)
  handle('cloudWorkspaces:putPrefs', async (args) => {
    const parsed = z
      .object({ document: CloudWorkspacePrefsDocumentSchema, revision: z.number().int().min(0) })
      .safeParse(args)
    const s = await getService()
    return !s
      ? NOT_CONFIGURED
      : parsed.success
        ? s.putPrefs(parsed.data.document, parsed.data.revision)
        : INVALID
  })
  handle('cloudWorkspaces:getOrgSlug', async (args) => {
    const parsed = z.object({ orgName: z.string().max(200).nullable().optional() }).safeParse(args)
    const s = await getService()
    return !s ? NOT_CONFIGURED : s.getOrgSlug(parsed.success ? parsed.data.orgName : null)
  })
}

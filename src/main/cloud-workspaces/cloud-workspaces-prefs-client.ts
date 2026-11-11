// Synced cloud workspace prefs (pins, order, sections) and the org's link slug, on the same
// authenticated call as the rest of the team registry client.
import type { z } from 'zod'
import {
  CloudOrgSlugSchema,
  CloudWorkspacePrefsSchema,
  type CloudOrgSlug,
  type CloudWorkspacePrefs,
  type CloudWorkspacePrefsDocument
} from '../../shared/cloud-workspaces/cloud-workspaces-wire'

type Call = <T>(
  method: 'GET' | 'PUT',
  path: string,
  schema: z.ZodType<T>,
  body?: unknown
) => Promise<T>

export function cloudWorkspacePrefsMethods(call: Call) {
  return {
    /** This member's synced arrangement for the current account. */
    getPrefs(): Promise<CloudWorkspacePrefs> {
      return call('GET', '/v1/team/prefs', CloudWorkspacePrefsSchema)
    },
    /** Compare-and-set: a stale `revision` answers 409 `conflict`; re-read and re-apply. */
    putPrefs(
      document: CloudWorkspacePrefsDocument,
      revision: number,
      deviceId?: string
    ): Promise<CloudWorkspacePrefs> {
      // JSON drops an undefined deviceId.
      return call('PUT', '/v1/team/prefs', CloudWorkspacePrefsSchema, {
        document,
        revision,
        deviceId
      })
    },
    /** The org's link slug; `name` (the org name this client shows) names it the first time. */
    getOrgSlug(name?: string | null): Promise<CloudOrgSlug> {
      const qs = name ? `?${new URLSearchParams({ name: name.slice(0, 120) })}` : ''
      return call('GET', `/v1/team/org${qs}`, CloudOrgSlugSchema)
    }
  }
}

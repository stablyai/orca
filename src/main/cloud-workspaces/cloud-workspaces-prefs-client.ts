// Synced cloud workspace prefs (pins, order, sections), on the same authenticated call as the rest
// of the team registry client.
import type { z } from 'zod'
import {
  CloudWorkspacePrefsSchema,
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
    }
  }
}

// IPC for synced cloud workspace prefs (pins, order, sections).
// Registered with the other cloud workspace handlers; same `not_configured` contract.
import { z } from 'zod'
import { CloudWorkspacePrefsDocumentSchema } from '../../shared/cloud-workspaces/cloud-workspaces-wire'
import type { ServeCloudWorkspaces } from './cloud-workspaces'

export function registerCloudWorkspacePrefsHandlers(serve: ServeCloudWorkspaces): void {
  serve('cloudWorkspaces:getPrefs', z.unknown(), (s) => s.getPrefs())
  serve(
    'cloudWorkspaces:putPrefs',
    z.object({ document: CloudWorkspacePrefsDocumentSchema, revision: z.number().int().min(0) }),
    (s, { document, revision }) => s.putPrefs(document, revision)
  )
}

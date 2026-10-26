import type { CloudDatabase } from '@orca-cloud/cloud-database'
import { z } from 'zod'
import type { ConnectorSource } from './connector-adapter.js'

// An operator-seeded link from a source's user to an Orca account, with their machine-choice defaults.
export type ConnectorIdentity = {
  accountId: string
  defaultHostId: string | null
  defaultProject: string | null
  // Container (channel) id → project name or remote; wins over defaultProject there.
  containerProjects: Record<string, string>
}

export type IdentityKey = { source: ConnectorSource; workspaceId: string; userId: string }

const ContainerProjectsSchema = z.record(z.string(), z.string().min(1))

export async function findIdentity(
  database: CloudDatabase,
  key: IdentityKey
): Promise<ConnectorIdentity | null> {
  const [row] = await database.query(
    `SELECT account_id, default_host_id, default_project, container_projects
     FROM connector_identities WHERE source = ? AND workspace_id = ? AND user_id = ?`,
    [key.source, key.workspaceId, key.userId]
  )
  if (!row) {
    return null
  }
  return {
    accountId: String(row.account_id),
    defaultHostId: row.default_host_id === null ? null : String(row.default_host_id),
    defaultProject: row.default_project === null ? null : String(row.default_project),
    containerProjects: ContainerProjectsSchema.parse(JSON.parse(String(row.container_projects)))
  }
}

export async function saveIdentity(
  database: CloudDatabase,
  link: IdentityKey & ConnectorIdentity,
  now: number
): Promise<void> {
  await database.query(
    `INSERT INTO connector_identities
     (source, workspace_id, user_id, account_id, default_host_id, default_project,
      container_projects, linked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (source, workspace_id, user_id) DO UPDATE SET account_id = excluded.account_id,
       default_host_id = excluded.default_host_id, default_project = excluded.default_project,
       container_projects = excluded.container_projects, linked_at = excluded.linked_at`,
    [
      link.source,
      link.workspaceId,
      link.userId,
      link.accountId,
      link.defaultHostId,
      link.defaultProject,
      JSON.stringify(link.containerProjects),
      now
    ]
  )
}

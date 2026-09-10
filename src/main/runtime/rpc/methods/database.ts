import { z } from 'zod'
import { DatabaseCredentialVault } from '../../../database/database-credential-vault'
import { DatabaseProfileService } from '../../../database/database-profile-service'
import { DatabaseProfileStore } from '../../../database/database-profile-store'
import { DatabaseService } from '../../../database/database-service'
import { ensureActiveOrcaProfile } from '../../../orca-profiles/profile-index-store'
import { defineMethod, type RpcMethod } from '../core'

let service: DatabaseService | null = null

function getService(): DatabaseService {
  if (service) {
    return service
  }
  const { profileDirectory } = ensureActiveOrcaProfile()
  const profiles = new DatabaseProfileService(
    new DatabaseProfileStore(profileDirectory),
    new DatabaseCredentialVault(profileDirectory)
  )
  service = new DatabaseService(undefined, undefined, profiles)
  return service
}

const DatabaseConnection = z
  .object({
    providerId: z.literal('postgres'),
    host: z.string().trim().min(1).max(255),
    port: z.number().int().min(1).max(65_535),
    database: z.string().trim().min(1).max(255),
    schema: z.string().trim().min(1).max(255).optional(),
    user: z.string().trim().min(1).max(255),
    sslMode: z.enum(['disable', 'require', 'verify-full'])
  })
  .strict()

const DatabaseCredential = z
  .object({
    password: z.string().max(16_384).optional()
  })
  .strict()

const DatabaseExecution = z
  .object({
    kind: z.literal('ssh'),
    connectionId: z.string().trim().min(1).max(255)
  })
  .strict()

const DatabaseConnectionRequest = z
  .object({
    profileId: z.string().min(1).max(128).optional(),
    connection: DatabaseConnection,
    credential: DatabaseCredential,
    execution: DatabaseExecution.optional()
  })
  .strict()

const DatabaseQueryRequest = DatabaseConnectionRequest.extend({
  queryId: z.string().min(1).max(128),
  sql: z
    .string()
    .trim()
    .min(1)
    .max(1024 * 1024),
  readOnly: z.boolean(),
  maxRows: z.number().int().min(1).max(10_000),
  timeoutMs: z.number().int().min(100).max(300_000)
})

const DatabaseCancelRequest = z.object({
  providerId: z.literal('postgres'),
  queryId: z.string().min(1).max(128)
})

const DatabaseNodeRequest = z
  .object({
    execution: DatabaseExecution.optional()
  })
  .strict()

const DatabaseProfileSaveRequest = DatabaseNodeRequest.extend({
  profile: z
    .object({
      id: z.string().min(1).max(128).optional(),
      name: z.string().trim().min(1).max(120),
      connection: DatabaseConnection
    })
    .strict(),
  credential: DatabaseCredential,
  credentialAction: z.enum(['preserve', 'save', 'delete'])
})

const DatabaseProfileDeleteRequest = DatabaseNodeRequest.extend({
  profileId: z.string().min(1).max(128)
})

export const DATABASE_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'database.testConnection',
    params: DatabaseConnectionRequest,
    handler: (params, { signal }) => getService().testConnection(params, signal)
  }),
  defineMethod({
    name: 'database.introspect',
    params: DatabaseConnectionRequest,
    handler: (params, { signal }) => getService().introspect(params, signal)
  }),
  defineMethod({
    name: 'database.catalog',
    params: DatabaseConnectionRequest,
    handler: (params, { signal }) => getService().catalog(params, signal)
  }),
  defineMethod({
    name: 'database.execute',
    params: DatabaseQueryRequest,
    handler: (params, { signal }) => getService().execute(params, signal)
  }),
  defineMethod({
    name: 'database.cancel',
    params: DatabaseCancelRequest,
    handler: async (params) => ({
      canceled: await getService().cancel(params.providerId, params.queryId)
    })
  }),
  defineMethod({
    name: 'database.profiles.list',
    params: DatabaseNodeRequest,
    handler: (params) => ({ profiles: getService().listProfiles(params.execution) })
  }),
  defineMethod({
    name: 'database.profiles.save',
    params: DatabaseProfileSaveRequest,
    handler: (params) => getService().saveProfile(params)
  }),
  defineMethod({
    name: 'database.profiles.delete',
    params: DatabaseProfileDeleteRequest,
    handler: (params) => ({
      deleted: getService().deleteProfile(params.profileId, params.execution)
    })
  })
]

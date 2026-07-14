import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import {
  toPersistedDatabaseConnection,
  type DatabaseExecutionContext,
  type DatabaseProfileSummary
} from '../../shared/database-types'
import { writeSecureJsonFile } from '../../shared/secure-file'

const DATABASE_PROFILE_STORE_VERSION = 1
const DATABASE_PROFILE_STORE_FILE = 'database-profiles.json'

const StoredConnectionSchema = z.object({
  providerId: z.literal('postgres'),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65_535),
  database: z.string().min(1),
  schema: z.string().min(1).optional(),
  user: z.string().min(1),
  sslMode: z.enum(['disable', 'require', 'verify-full'])
})

const StoredProfileSchema = z.object({
  id: z.string().min(1),
  nodeKey: z.string().min(1),
  name: z.string().min(1),
  connection: StoredConnectionSchema,
  createdAt: z.number(),
  updatedAt: z.number()
})

const StoredProfileFileSchema = z.object({
  version: z.literal(DATABASE_PROFILE_STORE_VERSION),
  profiles: z.array(StoredProfileSchema)
})

type StoredProfile = z.infer<typeof StoredProfileSchema>
type StoredProfileFile = z.infer<typeof StoredProfileFileSchema>

export type DatabaseProfileRecord = Omit<DatabaseProfileSummary, 'hasSavedPassword'>

export function databaseNodeKey(execution?: DatabaseExecutionContext): string {
  return execution?.kind === 'ssh' ? `ssh:${execution.connectionId}` : 'local'
}

export class DatabaseProfileStore {
  private readonly path: string

  constructor(profileDirectory: string) {
    this.path = join(profileDirectory, DATABASE_PROFILE_STORE_FILE)
  }

  list(execution?: DatabaseExecutionContext): DatabaseProfileRecord[] {
    const nodeKey = databaseNodeKey(execution)
    return this.read()
      .profiles.filter((profile) => profile.nodeKey === nodeKey)
      .map(toProfileRecord)
      .sort((left, right) => left.name.localeCompare(right.name))
  }

  get(profileId: string, execution?: DatabaseExecutionContext): DatabaseProfileRecord | null {
    const nodeKey = databaseNodeKey(execution)
    const profile = this.read().profiles.find(
      (candidate) => candidate.id === profileId && candidate.nodeKey === nodeKey
    )
    return profile ? toProfileRecord(profile) : null
  }

  save(
    profile: DatabaseProfileRecord,
    execution?: DatabaseExecutionContext
  ): DatabaseProfileRecord {
    const state = this.read()
    const nodeKey = databaseNodeKey(execution)
    const existingIndex = state.profiles.findIndex((candidate) => candidate.id === profile.id)
    if (existingIndex >= 0 && state.profiles[existingIndex]?.nodeKey !== nodeKey) {
      throw new Error('Database profile belongs to a different project node')
    }
    const stored: StoredProfile = {
      ...profile,
      nodeKey,
      connection: toPersistedDatabaseConnection(profile.connection)
    }
    const profiles = [...state.profiles]
    if (existingIndex >= 0) {
      profiles[existingIndex] = stored
    } else {
      profiles.push(stored)
    }
    this.write({ version: DATABASE_PROFILE_STORE_VERSION, profiles })
    return toProfileRecord(stored)
  }

  delete(profileId: string, execution?: DatabaseExecutionContext): boolean {
    const state = this.read()
    const nodeKey = databaseNodeKey(execution)
    const existing = state.profiles.find(
      (candidate) => candidate.id === profileId && candidate.nodeKey === nodeKey
    )
    if (!existing) {
      return false
    }
    this.write({
      version: DATABASE_PROFILE_STORE_VERSION,
      profiles: state.profiles.filter((candidate) => candidate.id !== profileId)
    })
    return true
  }

  private read(): StoredProfileFile {
    if (!existsSync(this.path)) {
      return { version: DATABASE_PROFILE_STORE_VERSION, profiles: [] }
    }
    try {
      return StoredProfileFileSchema.parse(JSON.parse(readFileSync(this.path, 'utf8')))
    } catch {
      throw new Error('The database profile store is invalid and was not modified')
    }
  }

  private write(value: StoredProfileFile): void {
    writeSecureJsonFile(this.path, value)
  }
}

function toProfileRecord(profile: StoredProfile): DatabaseProfileRecord {
  return {
    id: profile.id,
    name: profile.name,
    connection: profile.connection,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt
  }
}

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseProfileSaveRequest } from '../../shared/database-types'
import { DatabaseCredentialVault } from './database-credential-vault'
import { DatabaseProfileService } from './database-profile-service'
import { DatabaseProfileStore } from './database-profile-store'
import type { DatabaseVaultKeyProtection } from './database-vault-key-protection'

const keyProtection: DatabaseVaultKeyProtection = {
  protect: (key) => ({ protection: 'local-file', payload: key.toString('base64') }),
  unprotect: (stored) => Buffer.from(stored.payload, 'base64')
}

const connection = {
  providerId: 'postgres' as const,
  host: 'db.internal',
  port: 5432,
  database: 'app',
  schema: 'public',
  user: 'developer',
  sslMode: 'require' as const
}

describe('DatabaseProfileService', () => {
  let directory: string
  let service: DatabaseProfileService

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'orca-database-profile-'))
    service = new DatabaseProfileService(
      new DatabaseProfileStore(directory),
      new DatabaseCredentialVault(directory, keyProtection)
    )
  })

  afterEach(() => rmSync(directory, { recursive: true, force: true }))

  it('stores profile metadata separately from an encrypted credential', () => {
    const saved = service.save(saveRequest('save', 'secret-password'))

    expect(saved).toMatchObject({ name: 'Application DB', hasSavedPassword: true })
    expect(JSON.stringify(saved)).not.toContain('secret-password')
    expect(readFileSync(join(directory, 'database-profiles.json'), 'utf8')).not.toContain(
      'secret-password'
    )
    expect(readFileSync(join(directory, 'database-credentials.json'), 'utf8')).not.toContain(
      'secret-password'
    )
    if (process.platform !== 'win32') {
      expect(statSync(join(directory, 'database-profiles.json')).mode & 0o777).toBe(0o600)
      expect(statSync(join(directory, 'database-credentials.json')).mode & 0o777).toBe(0o600)
      expect(statSync(join(directory, 'database-vault-key.json')).mode & 0o777).toBe(0o600)
    }
  })

  it('resolves a saved password only for its bound server endpoint', () => {
    const saved = service.save(saveRequest('save', 'secret-password'))

    expect(
      service.resolveRequest({
        profileId: saved.id,
        connection: { ...connection, database: 'analytics', schema: 'reporting' },
        credential: {}
      })
    ).toMatchObject({
      connection: { database: 'analytics', schema: 'reporting' },
      credential: { password: 'secret-password' }
    })
    expect(() =>
      service.resolveRequest({
        profileId: saved.id,
        connection: { ...connection, host: 'attacker.invalid' },
        credential: {}
      })
    ).toThrow('Save the edited connection')
  })

  it('honors an explicitly cleared schema while resolving a saved password', () => {
    const saved = service.save(saveRequest('save', 'secret-password'))
    const connectionWithoutSchema = { ...connection, schema: undefined }

    const resolved = service.resolveRequest({
      profileId: saved.id,
      connection: connectionWithoutSchema,
      credential: {}
    })

    expect(resolved.connection).toEqual(connectionWithoutSchema)
    expect(resolved.credential.password).toBe('secret-password')
  })

  it('isolates profiles by project node and deletes the credential with the profile', () => {
    const execution = { kind: 'ssh' as const, connectionId: 'ssh-p8' }
    const saved = service.save({ ...saveRequest('save', 'secret-password'), execution })

    expect(service.list()).toEqual([])
    expect(service.list(execution)).toHaveLength(1)
    expect(service.delete(saved.id, execution)).toBe(true)
    expect(service.list(execution)).toEqual([])
  })

  it('requires a new password before rebinding a saved profile to another endpoint', () => {
    const saved = service.save(saveRequest('save', 'old-server-password'))

    expect(() =>
      service.save({
        profile: {
          id: saved.id,
          name: saved.name,
          connection: { ...connection, host: 'new-db.internal' }
        },
        credential: {},
        credentialAction: 'preserve'
      })
    ).toThrow('Enter the password again')
    expect(service.list()[0]?.connection.host).toBe('db.internal')

    const rebound = service.save({
      profile: {
        id: saved.id,
        name: saved.name,
        connection: { ...connection, host: 'new-db.internal' }
      },
      credential: { password: 'new-server-password' },
      credentialAction: 'save'
    })
    expect(
      service.resolveRequest({
        profileId: rebound.id,
        connection: rebound.connection,
        credential: {}
      }).credential.password
    ).toBe('new-server-password')
  })

  it('does not write metadata when saving a credential without a password', () => {
    expect(() => service.save(saveRequest('save'))).toThrow('Enter a password')
    expect(service.list()).toEqual([])
  })

  it('rejects a credential whose authenticated ciphertext was modified', () => {
    const saved = service.save(saveRequest('save', 'secret-password'))
    const credentialPath = join(directory, 'database-credentials.json')
    const contents = JSON.parse(readFileSync(credentialPath, 'utf8')) as {
      credentials: Record<string, { tag: string }>
    }
    contents.credentials[saved.id]!.tag = Buffer.alloc(16).toString('base64')
    writeFileSync(credentialPath, JSON.stringify(contents))

    expect(() =>
      service.resolveRequest({
        profileId: saved.id,
        connection,
        credential: {}
      })
    ).toThrow('could not be decrypted')
  })
})

function saveRequest(
  credentialAction: DatabaseProfileSaveRequest['credentialAction'],
  password?: string
): DatabaseProfileSaveRequest {
  return {
    profile: { name: ' Application DB ', connection },
    credential: { password },
    credentialAction
  }
}

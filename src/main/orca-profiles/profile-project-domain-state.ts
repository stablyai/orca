import {
  openProfileStateDatabase,
  openProfileStateDatabaseReadOnly
} from '../persistence/profile-state/profile-state-database'
import {
  readProfileStateDocuments,
  readProfileStateRevision
} from '../persistence/profile-state/profile-state-documents'
import type { ProfileStateParsedDocument } from '../persistence/profile-state/profile-state-document-validation'
import { writeProfileStateDomainsInTransaction } from '../persistence/profile-state/profile-state-domain-writes'
import { withProfileStateWriteTransaction } from '../persistence/profile-state/profile-state-write-transaction'
import {
  WORKSPACE_SURFACE_DOMAIN,
  surfaceProfileDomainSchema
} from '../../shared/workspace-surfaces/surface-profile-domain'
import { withProfileStateReadSnapshot } from '../persistence/profile-state/profile-state-read-snapshot'
import { getOrcaProfileStateDatabaseFile } from './profile-storage-paths'
import { ensureProfileStateAuthorityMarker } from '../persistence/profile-state/profile-state-authority-marker'
import {
  normalizeProfileProjectState,
  profileStateStorage,
  readProfileStateWithRevision,
  type ReadProfileStateResult
} from './profile-project-state-file'
import {
  validateProfileProjectDomainChanges,
  profileProjectDomainDigests,
  profileProjectDomainFingerprint,
  type ProfileProjectDomainChanges
} from './profile-project-domain-changes'
import { executeSurfaceOwnerCommands } from '../workspace-surfaces/surface-owner-command'
import { normalizeExecutionHostId, parseExecutionHostId } from '../../shared/execution-host'

export type ReadProfileProjectTransferResult = ReadProfileStateResult & {
  documents?: readonly ProfileStateParsedDocument[]
}

/** Participant writers are excluded; reconcile released compatibility edits before taking move images. */
export function initializeProfileProjectSurfaces(
  profileId: string,
  userDataPath: string,
  snapshot: ReadProfileProjectTransferResult
): ReadProfileProjectTransferResult {
  const opened = openProfileStateDatabase(
    getOrcaProfileStateDatabaseFile(profileId, userDataPath),
    profileId
  )
  try {
    const hosts = new Set([
      'local',
      ...Object.keys(snapshot.state.workspaceSurfaces?.hosts ?? {}),
      ...Object.keys(snapshot.state.workspaceSessionsByHostId ?? {})
    ])
    const commands = [...hosts].flatMap((hostId) => {
      if (normalizeExecutionHostId(hostId) !== hostId) {
        throw new Error('Stored workspace surface host identity is invalid')
      }
      return parseExecutionHostId(hostId)?.kind === 'runtime'
        ? []
        : [{ type: 'initialize' as const, hostId }]
    })
    executeSurfaceOwnerCommands(opened.db, snapshot.revision!, commands)
  } finally {
    opened.db.close()
  }
  return readProfileProjectTransferState(profileId, userDataPath)
}

/** Preserve checked domain values without reparsing the whole profile. */
export function readProfileProjectTransferState(
  profileId: string,
  userDataPath: string
): ReadProfileProjectTransferResult {
  if (profileStateStorage(profileId, userDataPath) === 'json') {
    return readProfileStateWithRevision(profileId, userDataPath)
  }
  const opened = openProfileStateDatabaseReadOnly(
    getOrcaProfileStateDatabaseFile(profileId, userDataPath),
    profileId
  )
  try {
    return withProfileStateReadSnapshot(opened.db, () => {
      const revision = readProfileStateRevision(opened.db)
      const documents = readProfileStateDocuments(opened.db, {
        profileRevision: revision,
        representation: 'parsed'
      })
      return {
        revision,
        documents,
        state: normalizeProfileProjectState(
          Object.fromEntries(documents.map(({ domain, value }) => [domain, value]))
        )
      }
    })
  } finally {
    opened.db.close()
  }
}

export function writeProfileProjectDomainChanges(
  profileId: string,
  userDataPath: string,
  changes: ProfileProjectDomainChanges
): void {
  validateProfileProjectDomainChanges(changes)
  const replacements = changes.replacements.map(({ domain, payload }) => ({ domain, payload }))
  if (profileStateStorage(profileId, userDataPath) !== 'sqlite') {
    throw new Error('Profile domain transfer requires an established SQLite participant')
  }
  const databaseFile = getOrcaProfileStateDatabaseFile(profileId, userDataPath)
  const opened = openProfileStateDatabase(databaseFile, profileId)
  try {
    ensureProfileStateAuthorityMarker(databaseFile)
    withProfileStateWriteTransaction(opened.db, () => {
      const replacement = replacements.find(({ domain }) => domain === WORKSPACE_SURFACE_DOMAIN)
      const surfaceCommit = replacement?.payload
        ? surfaceProfileDomainSchema.parse(JSON.parse(replacement.payload))
        : undefined
      const result = writeProfileStateDomainsInTransaction(
        opened.db,
        {
          expectedRevision: changes.expectedRevision,
          replacements
        },
        surfaceCommit
      )
      const documents = readProfileStateDocuments(opened.db, {
        profileRevision: result.revision,
        representation: 'parsed'
      })
      if (
        !result.changed ||
        result.revision !== changes.expectedRevision + 1 ||
        profileProjectDomainFingerprint(profileProjectDomainDigests(documents)) !==
          changes.afterHash
      ) {
        throw new Error('Profile domain transfer did not commit its expected after-image')
      }
    })
  } finally {
    opened.db.close()
  }
}

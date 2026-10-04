import {
  openProfileStateDatabase,
  openProfileStateDatabaseReadOnly
} from '../persistence/profile-state/profile-state-database'
import {
  readProfileStateDocuments,
  readProfileStateRevision
} from '../persistence/profile-state/profile-state-documents'
import type { ProfileStateParsedDocument } from '../persistence/profile-state/profile-state-document-validation'
import { writeProfileStateDomains } from '../persistence/profile-state/profile-state-domain-writes'
import { withProfileStateReadSnapshot } from '../persistence/profile-state/profile-state-read-snapshot'
import { getOrcaProfileStateDatabaseFile } from './profile-storage-paths'
import {
  normalizeProfileProjectState,
  profileStateStorage,
  readProfileStateWithRevision,
  type ReadProfileStateResult
} from './profile-project-state-file'
import {
  validateProfileProjectDomainChanges,
  type ProfileProjectDomainChanges
} from './profile-project-domain-changes'

export type ReadProfileProjectTransferResult = ReadProfileStateResult & {
  documents?: readonly ProfileStateParsedDocument[]
}

/** Keep checked domain values for transfer without joining and reparsing the complete profile. */
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
  if (profileStateStorage(profileId, userDataPath) !== 'sqlite') {
    throw new Error('Profile domain transfer requires an established SQLite participant')
  }
  const opened = openProfileStateDatabase(
    getOrcaProfileStateDatabaseFile(profileId, userDataPath),
    profileId
  )
  try {
    const result = writeProfileStateDomains(opened.db, {
      expectedRevision: changes.expectedRevision,
      replacements: changes.replacements.map(({ domain, payload }) => ({ domain, payload }))
    })
    if (!result.changed || result.revision !== changes.expectedRevision + 1) {
      throw new Error('Profile domain transfer did not commit its expected revision')
    }
  } finally {
    opened.db.close()
  }
}

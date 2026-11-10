import { readFile } from 'node:fs/promises'
import { canonicalTerminalClaimDatabase } from './profile-state-terminal-claim-location'
import {
  getOrcaProfileDataFile,
  getOrcaProfileStateDatabaseFile
} from '../../../shared/profile-state-storage-paths'
import { profileStateStorage } from '../../orca-profiles/profile-project-state-file'
import { readProfileStateDomains } from './profile-state-domain-reader'
import { parseProfileStateRoot } from './profile-state-document-validation'
import { projectProfileTerminalClaims } from './profile-state-terminal-claim-projection'
import type {
  ProfileTerminalClaims,
  ProfileTerminalClaimsRequest
} from './profile-state-terminal-claims-contract'

const domains = [
  'repos',
  'folderWorkspaces',
  'projectGroups',
  'workspaceSession',
  'workspaceSessionsByHostId'
]

/** Runs in the existing writer worker; foreign damage cannot retire the active authority. */
export async function readProfileTerminalClaims(
  request: ProfileTerminalClaimsRequest
): Promise<ProfileTerminalClaims> {
  try {
    const { profileId, userDataPath } = request
    const databaseFile = getOrcaProfileStateDatabaseFile(profileId, userDataPath)
    const location = await canonicalTerminalClaimDatabase(databaseFile)
    if (profileStateStorage(profileId, userDataPath) === 'sqlite') {
      const snapshot = readProfileStateDomains(databaseFile, profileId, domains)
      if (snapshot.kind !== 'values') {
        return { kind: 'unknown' }
      }
      return {
        kind: 'known',
        location,
        revision: snapshot.revision,
        numericIds: projectProfileTerminalClaims(snapshot.values)
      }
    }
    const root = parseProfileStateRoot(
      await readFile(getOrcaProfileDataFile(profileId, userDataPath), 'utf8')
    )
    return {
      kind: 'known',
      location,
      numericIds: projectProfileTerminalClaims(
        new Map(domains.map((domain) => [domain, root[domain]]))
      )
    }
  } catch {
    return { kind: 'unknown' }
  }
}

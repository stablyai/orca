import { journalSqlFailure } from '../../native-chat/agent-session-journal/journal-sql-protocol'
import { JournalUnitUpload } from '../../native-chat/agent-session-journal/journal-unit-upload'
import { journalResultPackets } from '../../native-chat/agent-session-journal/journal-unit-transfer'
import type { ProfileStateWriterJournalPackets } from './profile-state-writer-protocol'
import { parentPort, workerData } from 'node:worker_threads'
import { ProfileStateSqliteAuthority } from './profile-state-sqlite-authority'
import { writeVersionedProfileStateExport } from './legacy-json/profile-state-versioned-export'
import {
  encodeProfileStateWriterError,
  ProfileStateWriterError
} from './profile-state-writer-errors'
import {
  isProfileStateWriterInitialization,
  isProfileStateWriterRequest,
  type ProfileStateWriterRequest,
  type ProfileStateWriterResponse
} from './profile-state-writer-protocol'

if (!parentPort) {
  throw new Error('Profile state writer requires a worker thread')
}
const port = parentPort
let authority: ProfileStateSqliteAuthority | undefined
let busy = false
let stopping = false
let previousId = 0
const journalUpload = new JournalUnitUpload()

function reply(response: ProfileStateWriterResponse | ProfileStateWriterJournalPackets): void {
  port.postMessage(response)
}

function close(): void {
  stopping = true
  try {
    authority?.close()
  } finally {
    port.close()
  }
}

async function execute(request: ProfileStateWriterRequest): Promise<ProfileStateWriterResponse> {
  if (!authority) {
    throw new Error('Profile state writer is not initialized')
  }
  let exportedRevision: number | null | undefined
  let surfaceResult: Extract<ProfileStateWriterResponse, { ok: true }>['surfaceResult']
  let surfaceResults: Extract<ProfileStateWriterResponse, { ok: true }>['surfaceResults']
  switch (request.command) {
    case 'stage-surface-journal':
      if (request.packets === null) {
        journalUpload.clear()
      } else {
        journalUpload.append(request.packets)
      }
      break
    case 'write-surface-joint': {
      const committed = authority.executeSurfaceJournalUnit(
        request.transaction,
        journalUpload.take(request.transaction.effectCount ?? 0)
      )
      surfaceResults = committed.surfaces
      for (const journalPackets of journalResultPackets(committed.values)) {
        reply({ id: request.id, journalPackets })
      }
      break
    }
    case 'write-surfaces':
      surfaceResults = authority.executeSurfaceTransaction(request.surfaces)
      break
    case 'write-surface':
      surfaceResult = authority.executeSurfaceCommand(request.surface)
      break
    case 'write-state':
      authority.writeSerializedState(Buffer.from(request.payload))
      break
    case 'write-complete':
      authority.writeCompleteSerializedDomains(request.replacements)
      break
    case 'write-domains':
      authority.writeSerializedDomains(request.replacements)
      break
    case 'write-automation':
      authority.writeSerializedAutomationRuns(
        request.replacements,
        request.runPayloads.map((payload): unknown => JSON.parse(payload))
      )
      break
    case 'assert-revision':
      authority.assertCurrentRevision()
      break
    case 'export-json':
      authority.assertCurrentRevision()
      exportedRevision = authority.writeJsonExport(request.targetPath)
      break
    case 'export-latest':
      authority.assertCurrentRevision()
      exportedRevision =
        writeVersionedProfileStateExport(
          request.targetPath,
          authority.writeJsonExport.bind(authority)
        ) ?? null
      break
    case 'close':
      authority.close()
      stopping = true
      break
  }
  return {
    id: request.id,
    ok: true,
    revision: authority.revision,
    ...(surfaceResult === undefined ? {} : { surfaceResult }),
    ...(surfaceResults === undefined ? {} : { surfaceResults }),
    ...(exportedRevision === undefined ? {} : { exportedRevision })
  }
}

async function accept(value: unknown): Promise<void> {
  if (stopping) {
    return
  }
  if (!isProfileStateWriterRequest(value) || busy || value.id <= previousId) {
    stopping = true
    reply({
      id: 0,
      ok: false,
      error: encodeProfileStateWriterError(
        new ProfileStateWriterError(
          'profile-state-writer-protocol',
          'Invalid profile state writer request',
          'indeterminate'
        )
      )
    })
    if (!busy) {
      close()
    }
    return
  }
  busy = true
  previousId = value.id
  try {
    reply(await execute(value))
  } catch (error) {
    // Export staging accepts both JSON versions; only uncertain SQL outcomes retire the writer.
    const failure = encodeProfileStateWriterError(error, value.command === 'close')
    if (value.command === 'write-surface-joint' && failure.outcome === 'known-failure') {
      failure.journal = journalSqlFailure(error)
    }
    reply({ id: value.id, ok: false, error: failure })
    stopping ||= failure.outcome === 'indeterminate'
  } finally {
    busy = false
    if (stopping) {
      close()
    }
  }
}

try {
  const initialization: unknown = workerData
  if (!isProfileStateWriterInitialization(initialization)) {
    throw new ProfileStateWriterError(
      'profile-state-writer-initialization',
      'Invalid profile state writer initialization',
      'known-failure'
    )
  }
  authority = new ProfileStateSqliteAuthority(initialization.databasePath, initialization.profileId)
  authority.initializeFromRevision(initialization.revision)
  reply({ id: 0, ok: true, revision: authority.revision })
  port.on('message', (value: unknown) => {
    void accept(value)
  })
} catch (error) {
  reply({ id: 0, ok: false, error: encodeProfileStateWriterError(error) })
  close()
}

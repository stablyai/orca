import {
  SURFACE_EVIDENCE_PREFIX,
  surfaceEvidenceDocumentSchema
} from '../../shared/workspace-surfaces/surface-evidence-document'
import {
  exportProfileStateJson,
  importProfileStateJson,
  readProfileStateParsedSnapshot,
  readProfileStateRevision
} from '../persistence/profile-state/profile-state-documents'
import {
  writeProfileStateDomains,
  writeProfileStateDomainsInTransaction
} from '../persistence/profile-state/profile-state-domain-writes'
import { buildCompleteDocumentReplacements } from '../persistence/profile-state/profile-state-complete-replacements'
import { attachSurfaceEvidenceReader } from './surface-cold-evidence'
import { reserveImportedSurfaceIdentities } from './surface-migration-identities'
import { readSurfaceOwner } from './surface-owner-read'
import { readSurfaceProfileSnapshot } from './surface-profile-cache'
import { runTargetOf } from '../../shared/workspace-surfaces/surface-allocation'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { getDefaultPersistedState, getDefaultWorkspaceSession } from '../../shared/constants'
import {
  WORKSPACE_SURFACE_DOMAIN,
  type SurfaceProfileDomain
} from '../../shared/workspace-surfaces/surface-profile-domain'
import type { WorkspaceSurface } from '../../shared/workspace-surfaces/surface-content'
import { projectSurfaceSession } from '../../shared/workspace-surfaces/surface-session-projection'
import { openWritableProfileStateDatabase } from '../persistence/profile-state/profile-state-database'
import { ProfileStateSqliteAuthority } from '../persistence/profile-state/profile-state-sqlite-authority'

import { withProfileStateWriteTransaction } from '../persistence/profile-state/profile-state-write-transaction'

import {
  captureSurfaceProfileDomain,
  markSurfaceIndices,
  readSurfaceProfileDomain,
  restoreSurfaceIndices,
  surfaceDomainFingerprint
} from './surface-profile-storage'
import { WorkspaceSurfaceRepository } from './surface-repository'
import type Database from '../sqlite/sync-database'
import { hashProfileStatePayload } from '../persistence/profile-state/profile-state-document-validation'
import { PROFILE_STATE_META_REVISION } from '../persistence/profile-state/profile-state-database-schema'
import { executeSurfaceOwnerCommand, executeSurfaceOwnerCommands } from './surface-owner-command'
import { preserveSurfaceRecoveryObligations } from './surface-recovery-obligations'
import {
  surfaceCarrierFromRecoveryJson,
  surfaceDocumentsFromRecoveryJson
} from './surface-recovery-evidence'

let directory: string
let databasePath: string
let db: Database.Database
const key = { hostId: 'local', workspaceId: 'folder', hostTabId: 'container' }
const leafId = '339343d0-9fcb-4d4d-8bf6-69615be0f927'
const terminal: WorkspaceSurface = {
  ...key,
  occurrence: 'surface',
  revision: 1,
  createdAt: 1,
  content: {
    kind: 'terminal',
    entityId: 'terminal',
    creation: {},
    root: { type: 'leaf', leafId },
    leaves: {
      [leafId]: {
        occurrence: 'leaf',
        runId: 'run',
        facts: { ptyId: 'process', incarnationId: 'incarnation' }
      }
    }
  }
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-surface-profile-'))
  databasePath = join(directory, 'profile-state.db')
  const authority = new ProfileStateSqliteAuthority(databasePath, 'test-profile')
  authority.writeSerializedState(Buffer.from(JSON.stringify(getDefaultPersistedState(directory))))
  authority.close()
  db = openWritableProfileStateDatabase(databasePath, 'test-profile').db
})
afterEach(() => {
  db.close()
  rmSync(directory, { recursive: true, force: true })
})

function commit(apply: (repository: WorkspaceSurfaceRepository) => void): SurfaceProfileDomain {
  return withProfileStateWriteTransaction(db, () => {
    const previous = readSurfaceProfileDomain(db)
    restoreSurfaceIndices(db, previous, surfaceDomainFingerprint(JSON.stringify(previous)))
    const repository = new WorkspaceSurfaceRepository(
      { db, readOnly: false, transaction: (run) => run(db) },
      () => 'minted',
      () => 10
    )
    apply(repository)
    const next = captureSurfaceProfileDomain(db, previous)
    const payload = JSON.stringify(next)
    const session = projectSurfaceSession(
      'local',
      getDefaultWorkspaceSession(),
      next.hosts.local?.surfaces ?? []
    )
    writeProfileStateDomainsInTransaction(
      db,
      {
        expectedRevision: readProfileStateRevision(db),
        replacements: [
          { domain: WORKSPACE_SURFACE_DOMAIN, payload },
          { domain: 'workspaceSession', payload: JSON.stringify(session) }
        ]
      },
      next
    )
    markSurfaceIndices(db, surfaceDomainFingerprint(payload))
    return next
  })
}

it('rolls back canonical content, receipt, resource retirement and profile output together', () => {
  const seeded = commit((repository) => repository.initialize('local', [terminal]))
  db.exec(`CREATE TRIGGER fail_surface_output BEFORE UPDATE ON profile_state_documents
    WHEN NEW.domain = 'workspaceSession' BEGIN SELECT RAISE(ABORT, 'output failed'); END`)
  expect(() =>
    commit((repository) =>
      repository.replaceContent({
        ...key,
        callerId: 'test',
        commandId: 'close',
        expiresAt: 100,
        expected: terminal,
        content: null
      })
    )
  ).toThrow('output failed')
  expect(readSurfaceProfileDomain(db)).toEqual(seeded)
  const repository = new WorkspaceSurfaceRepository({
    db,
    readOnly: false,
    transaction: (run) => run(db)
  })
  expect(repository.read(key)).toEqual(terminal)
  expect(repository.runs.allocations('local')).toEqual([])
  expect(db.prepare('SELECT * FROM main.workspace_surface_commands').all()).toEqual([])
})

it('carries exact unacknowledged retirement and accepted outcome through a real JSON export and rebuild', () => {
  commit((repository) => repository.initialize('local', [terminal]))
  const closed = commit((repository) =>
    repository.replaceContent({
      ...key,
      callerId: 'test',
      commandId: 'close',
      expiresAt: 100,
      expected: terminal,
      content: null
    })
  )
  expect(closed.hosts.local?.allocations).toMatchObject([
    {
      allocationId: 'run',
      decision: 'aborting',
      resource: { ptyId: 'process', incarnationId: 'incarnation' }
    }
  ])
  db.close()
  const authority = new ProfileStateSqliteAuthority(databasePath, 'test-profile')
  const exportPath = join(directory, 'profile.json')
  authority.writeJsonExport(exportPath)
  authority.close()
  const rebuiltPath = join(directory, 'rebuilt.db')
  const rebuilt = new ProfileStateSqliteAuthority(rebuiltPath, 'rebuilt-profile')
  rebuilt.writeSerializedState(readFileSync(exportPath))
  rebuilt.close()
  db = openWritableProfileStateDatabase(rebuiltPath, 'rebuilt-profile').db
  expect(readSurfaceProfileDomain(db)).toEqual(closed)
  const changesBeforeQuery = db.prepare('SELECT total_changes() AS total').get()?.total
  const query = executeSurfaceOwnerCommand(db, readProfileStateRevision(db), {
    type: 'query',
    hostId: 'local',
    command: { callerId: 'test', commandId: 'close' }
  })
  expect(query.result.outcome).toEqual(closed.hosts.local?.receipts[0]?.outcome)
  expect(db.prepare('SELECT total_changes() AS total').get()?.total).toBe(changesBeforeQuery)
  expect(
    db.prepare("SELECT name FROM main.sqlite_schema WHERE name = 'workspace_surfaces'").get()
  ).toBeUndefined()
  withProfileStateWriteTransaction(db, () => {
    restoreSurfaceIndices(db, closed, surfaceDomainFingerprint(JSON.stringify(closed)))
  })
  const repository = new WorkspaceSurfaceRepository(
    {
      db,
      readOnly: false,
      transaction: (run) => withProfileStateWriteTransaction(db, () => run(db))
    },
    undefined,
    () => 1_000_000
  )
  expect(repository.runs.allocations('local')).toEqual(closed.hosts.local?.allocations)
  expect(
    repository.replaceContent({
      ...key,
      callerId: 'test',
      commandId: 'close',
      expiresAt: 100,
      expected: terminal,
      content: null
    })
  ).toEqual(closed.hosts.local?.receipts[0]?.outcome)
  expect(repository.read(key)?.content).toBeNull()
})

it('fences stale and omitted canonical roots through the real full-profile authority write', () => {
  const seeded = commit((repository) => repository.initialize('local', [terminal]))
  const staleSession = JSON.parse(
    String(
      db
        .prepare('SELECT payload FROM main.profile_state_documents WHERE domain = ?')
        .get('workspaceSession')?.payload
    )
  )
  const closed = commit((repository) =>
    repository.replaceContent({
      ...key,
      callerId: 'test',
      commandId: 'close',
      expiresAt: 100,
      expected: terminal,
      content: null
    })
  )
  db.close()
  const authority = new ProfileStateSqliteAuthority(databasePath, 'test-profile')
  authority.readSerializedState()
  authority.writeSerializedState(
    Buffer.from(
      JSON.stringify({
        ...getDefaultPersistedState(directory),
        workspaceSession: staleSession,
        [WORKSPACE_SURFACE_DOMAIN]: seeded
      })
    )
  )
  let state = JSON.parse(authority.readSerializedState()!)
  expect(state[WORKSPACE_SURFACE_DOMAIN]).toEqual(closed)
  expect(state.workspaceSession.tabsByWorktree.folder ?? []).toEqual([])
  authority.writeSerializedState(Buffer.from(JSON.stringify(getDefaultPersistedState(directory))))
  state = JSON.parse(authority.readSerializedState()!)
  expect(state[WORKSPACE_SURFACE_DOMAIN]).toEqual(closed)
  authority.close()
  db = openWritableProfileStateDatabase(databasePath, 'test-profile').db
})

it('accepts terminal commands without opening a corrupt chat file and retains exact close work across reopen', () => {
  const chatPath = join(directory, 'agent-session-journal.db')
  const corruptChat = Buffer.from('unreadable SQLite container')
  writeFileSync(chatPath, corruptChat)
  db.close()
  const authority = new ProfileStateSqliteAuthority(databasePath, 'test-profile')
  authority.readSerializedState()
  const initialized = authority.executeSurfaceCommand({ type: 'initialize', hostId: 'local' })
  const request = {
    ...key,
    callerId: 'ordinary-window',
    commandId: 'ordinary-create',
    // ast-grep-ignore: test-no-wall-clock -- The real storage owner validates this bounded deadline against its own clock.
    expiresAt: Date.now() + 60_000,
    command: {
      type: 'createTerminalTab' as const,
      workspace: 'folder',
      tabId: 'container',
      leafId
    },
    targets: [{ hostTabId: 'container', expected: null }]
  }
  const created = authority.executeSurfaceCommand({
    type: 'layout',
    hostId: 'local',
    request,
    session: initialized.session,
    facts: { startingLeafIds: [], bindings: [] }
  })
  expect(created.outcome).toMatchObject({
    status: 'accepted',
    effects: { startPaneKeys: [`container:${leafId}`] }
  })
  const surface = created.host.surfaces[0]!
  expect(created.session.tabsByWorktree.folder).toHaveLength(1)
  expect(created.allocations).toMatchObject([{ decision: 'pending', resourceId: null }])
  const allocation = created.allocations[0]!
  const begun = authority.executeSurfaceCommand({
    type: 'begin-run',
    hostId: 'local',
    target: allocation.target,
    resourceId: 'late-process'
  })
  expect(begun.outcome).toMatchObject({
    status: 'accepted',
    allocation: { resourceId: 'late-process' }
  })
  const closed = authority.executeSurfaceCommand({
    type: 'replace',
    hostId: 'local',
    request: {
      ...key,
      callerId: 'ordinary-window',
      commandId: 'ordinary-close',
      // ast-grep-ignore: test-no-wall-clock -- The real storage owner validates this bounded deadline against its own clock.
      expiresAt: Date.now() + 60_000,
      expected: surface,
      content: null
    }
  })
  expect(closed.session.tabsByWorktree.folder ?? []).toEqual([])
  authority.close()
  const reopened = new ProfileStateSqliteAuthority(databasePath, 'test-profile')
  reopened.readSerializedState()
  const late = reopened.executeSurfaceCommand({
    type: 'bind-run',
    hostId: 'local',
    allocationId: allocation.allocationId,
    resource: { ptyId: 'late-process', incarnationId: 'late-incarnation' }
  })
  expect(late.outcome).toMatchObject({ status: 'accepted', allocation: { decision: 'aborting' } })
  expect(late.host.surfaces).toEqual([])
  expect(late.session.tabsByWorktree.folder ?? []).toEqual([])
  expect(late.allocations).toHaveLength(1)
  expect(readFileSync(chatPath)).toEqual(corruptChat)
  reopened.close()
  db = openWritableProfileStateDatabase(databasePath, 'test-profile').db
})

it('imports an old terminal close once and keeps the exact unacknowledged resource retirement', () => {
  commit((repository) => repository.initialize('local', [terminal]))
  writeOldSession(getDefaultWorkspaceSession())
  db.close()
  const authority = new ProfileStateSqliteAuthority(databasePath, 'test-profile')
  authority.readSerializedState()
  const closed = authority.executeSurfaceCommand({ type: 'initialize', hostId: 'local' })
  expect(closed.host.surfaces).toEqual([])
  expect(closed.allocations).toMatchObject([
    {
      allocationId: 'run',
      decision: 'aborting',
      resource: { ptyId: 'process', incarnationId: 'incarnation' }
    }
  ])
  const revision = closed.host.revision
  const again = authority.executeSurfaceCommand({ type: 'initialize', hostId: 'local' })
  expect(again.host.revision).toBe(revision)
  expect(again.host.surfaces).toEqual(closed.host.surfaces)
  expect(again.allocations).toEqual(closed.allocations)
  authority.close()
  db = openWritableProfileStateDatabase(databasePath, 'test-profile').db
})

it('imports old process replacement without carrying a previous run identity into the new process', () => {
  commit((repository) => repository.initialize('local', [terminal]))
  const session = projectSurfaceSession('local', getDefaultWorkspaceSession(), [terminal])
  session.tabsByWorktree.folder![0]!.ptyId = 'replacement-process'
  session.terminalLayoutsByTabId.terminal!.ptyIdsByLeafId![leafId] = 'replacement-process'
  session.terminalPtyIncarnationsByPaneKey![`terminal:${leafId}`] = 'replacement-incarnation'
  writeOldSession(session)
  db.close()
  const authority = new ProfileStateSqliteAuthority(databasePath, 'test-profile')
  authority.readSerializedState()
  const imported = authority.executeSurfaceCommand({ type: 'initialize', hostId: 'local' })
  const content = imported.host.surfaces[0]!.content
  expect(content?.kind).toBe('terminal')
  if (content?.kind !== 'terminal') {
    throw new Error('Terminal replacement was lost')
  }
  expect(content.leaves[leafId]?.runId).not.toBe('run')
  expect(imported.allocations).toMatchObject([
    { allocationId: 'run', decision: 'aborting', resourceId: 'process' }
  ])
  expect(
    imported.allocations.some((row) => row.allocationId === content.leaves[leafId]!.runId)
  ).toBe(false)
  expect(imported.session.terminalLayoutsByTabId.terminal!.ptyIdsByLeafId![leafId]).toBe(
    'replacement-process'
  )
  authority.close()
  db = openWritableProfileStateDatabase(databasePath, 'test-profile').db
})

it('keeps later exact retirement and receipt when recovery selects older content', () => {
  const selected = commit((repository) => repository.initialize('local', [terminal]))
  const later = commit((repository) =>
    repository.replaceContent({
      ...key,
      callerId: 'recovery',
      commandId: 'later-close',
      expiresAt: 100,
      expected: terminal,
      content: null
    })
  )
  later.hosts.local!.chatInitialization = 'verified'
  const selectedBefore = structuredClone(selected)
  const laterBefore = structuredClone(later)
  const recovered = preserveSurfaceRecoveryObligations(selected, later)!
  expect(recovered.hosts.local!.surfaces[0]).toEqual(terminal)
  expect(recovered.hosts.local!.allocations).toMatchObject([
    { allocationId: 'run', decision: 'aborting', resource: { ptyId: 'process' } }
  ])
  expect(recovered.hosts.local!.receipts).toMatchObject([
    { callerId: 'recovery', commandId: 'later-close', outcome: { status: 'accepted' } }
  ])
  expect(recovered.hosts.local!.chatInitialization).toBe('unknown')
  expect(selected).toEqual(selectedBefore)
  expect(later).toEqual(laterBefore)
  expect(preserveSurfaceRecoveryObligations(undefined, later)!.hosts.local!.allocations).toEqual(
    recovered.hosts.local!.allocations
  )
})

it('reconstructs acknowledged later binding debt without changing selected content and lets explicit abort win', () => {
  const later = commit((repository) => repository.initialize('local', [terminal]))
  const selected = structuredClone(later)
  selected.hosts.local!.surfaces = []
  expect(later.hosts.local!.allocations).toEqual([])
  const recovered = preserveSurfaceRecoveryObligations(selected, later)!
  expect(recovered.hosts.local!.surfaces).toEqual([])
  expect(recovered.hosts.local!.allocations).toMatchObject([
    {
      allocationId: 'run',
      decision: 'aborting',
      resourceId: 'process',
      resource: { ptyId: 'process', incarnationId: 'incarnation' }
    }
  ])
  const stillBound = preserveSurfaceRecoveryObligations(later, later)!
  expect(stillBound.hosts.local!.allocations).toEqual([])
  later.hosts.local!.allocations = recovered.hosts.local!.allocations
  expect(
    preserveSurfaceRecoveryObligations(stillBound, later)!.hosts.local!.allocations
  ).toMatchObject([{ allocationId: 'run', decision: 'aborting' }])
})

it('does not let an old terminal close retire a native successor after one-file recovery', () => {
  commit((repository) => repository.initialize('local', [terminal]))
  commit((repository) =>
    repository.replaceContent({
      ...key,
      callerId: 'test',
      commandId: 'new-successor',
      expiresAt: 100,
      expected: terminal,
      content: { kind: 'agent-session', sessionId: 'conversation', agent: 'codex' }
    })
  )
  writeOldSession(getDefaultWorkspaceSession())
  db.close()
  const authority = new ProfileStateSqliteAuthority(databasePath, 'test-profile')
  authority.readSerializedState()
  const retained = authority.executeSurfaceCommand({ type: 'initialize', hostId: 'local' })
  expect(retained.host.surfaces[0]?.content).toEqual({
    kind: 'agent-session',
    sessionId: 'conversation',
    agent: 'codex'
  })
  authority.close()
  db = openWritableProfileStateDatabase(databasePath, 'test-profile').db
})

/** Simulate an older executable's independent compatibility edit, which knows no canonical domain. */
function writeOldSession(session: ReturnType<typeof getDefaultWorkspaceSession>): void {
  withProfileStateWriteTransaction(db, () => {
    const payload = JSON.stringify(session)
    const revision = readProfileStateRevision(db) + 1
    db.prepare(
      'UPDATE main.profile_state_documents SET payload = ?, content_hash = ?, revision = ? WHERE domain = ?'
    ).run(payload, hashProfileStatePayload(payload), revision, 'workspaceSession')
    db.prepare('UPDATE main.profile_state_meta SET value = ? WHERE key = ?').run(
      String(revision),
      PROFILE_STATE_META_REVISION
    )
  })
}

it('commits remote partition commands at one revision and rolls every partition back on output failure', () => {
  const hosts = ['ssh:first', 'ssh:second']
  const initialized = executeSurfaceOwnerCommands(
    db,
    readProfileStateRevision(db),
    hosts.map((hostId) => ({ type: 'initialize', hostId }))
  )
  let minted = 0
  const commands = hosts.map((hostId, index) => ({
    type: 'replace' as const,
    hostId,
    request: {
      ...key,
      hostId,
      hostTabId: `container-${index}`,
      callerId: 'batch-test',
      commandId: 'create',
      expiresAt: 100,
      expected: null,
      content: {
        ...terminal.content!,
        entityId: `terminal-${index}`,
        leaves: { [leafId]: { occurrence: `leaf-${index}`, runId: `run-${index}`, facts: {} } }
      }
    }
  }))
  const created = executeSurfaceOwnerCommands(
    db,
    initialized.revision,
    commands,
    () => `minted-${minted++}`,
    () => 10
  )
  expect(created.revision).toBe(initialized.revision + 1)
  const sessions = JSON.parse(
    String(
      db
        .prepare(
          "SELECT payload FROM profile_state_documents WHERE domain = 'workspaceSessionsByHostId'"
        )
        .get()?.payload
    )
  )
  for (const [index, hostId] of hosts.entries()) {
    expect(sessions[hostId].tabsByWorktree.folder[0].id).toBe(`terminal-${index}`)
    expect(created.results[index]?.host.surfaces).toHaveLength(1)
  }
  const before = readSurfaceProfileDomain(db)
  const refused = executeSurfaceOwnerCommands(
    db,
    created.revision,
    commands.map((command, index) => ({
      ...command,
      request: {
        ...command.request,
        commandId: 'stale-close',
        expected: {
          occurrence:
            index === 0 ? created.results[index]!.host.surfaces[0]!.occurrence : 'old-occurrence'
        },
        content: null
      }
    })),
    () => `minted-${minted++}`,
    () => 11
  )
  expect(refused.results.map(({ outcome }) => outcome)).toEqual([
    expect.objectContaining({ status: 'conflict', code: 'surface_changed' }),
    expect.objectContaining({ status: 'conflict', code: 'surface_changed' })
  ])
  expect(refused.revision).toBe(created.revision)
  expect(readSurfaceProfileDomain(db)).toEqual(before)
  expect(readProfileStateRevision(db)).toBe(created.revision)
  db.exec(`CREATE TRIGGER fail_batch_output BEFORE UPDATE ON profile_state_documents
    WHEN NEW.domain = 'workspaceSessionsByHostId' BEGIN SELECT RAISE(ABORT, 'batch output failed'); END`)
  expect(() =>
    executeSurfaceOwnerCommands(
      db,
      created.revision,
      commands.map((command, index) => ({
        ...command,
        request: {
          ...command.request,
          commandId: 'close',
          expected: created.results[index]!.host.surfaces[0]!,
          content: null
        }
      })),
      () => `minted-${minted++}`,
      () => 11
    )
  ).toThrow('batch output failed')
  expect(readSurfaceProfileDomain(db)).toEqual(before)
  expect(readProfileStateRevision(db)).toBe(created.revision)
})

it('reads only the last reserved recovery root while retaining nested exact resource facts', () => {
  const carrier = commit((repository) => repository.initialize('local', [terminal]))
  const payload = JSON.stringify(carrier)
  const largeHistory = JSON.stringify('unrelated history '.repeat(10_000))
  const raw = `{"workspaceSurfaces":{"invalid":"earlier duplicate"},"history":${largeHistory},"nested":{"workspaceSurfaces":null},"workspaceSurfaces":${payload},"tail":[false,null,42]}`
  expect(surfaceCarrierFromRecoveryJson(raw)).toEqual(carrier)
  expect(
    surfaceCarrierFromRecoveryJson(`{"nested":{"workspaceSurfaces":${payload}}}`)
  ).toBeUndefined()
  expect(() => surfaceCarrierFromRecoveryJson(`[${payload}]`)).toThrow('root must be an object')
  expect(() => surfaceCarrierFromRecoveryJson(raw.slice(0, -1))).toThrow()
  expect(() => surfaceCarrierFromRecoveryJson('{"workspaceSurfaces":null}')).toThrow()
  expect(() =>
    surfaceDocumentsFromRecoveryJson('{"workspaceSurfaceEvidence/invalid":false}')
  ).toThrow()
})

it('uses exact committed root stamps for warm reads, ignores unrelated profile revisions and discards rollback state', () => {
  commit((repository) => repository.initialize('local', [terminal]))
  const target = runTargetOf(terminal, leafId)!
  const request = { type: 'run' as const, hostId: 'local', target }
  const first = readSurfaceOwner(db, readProfileStateRevision(db), request)
  expect(first.result).toMatchObject({ type: 'run', surface: terminal })
  const snapshot = readSurfaceProfileSnapshot(db)
  withProfileStateWriteTransaction(db, () => {
    writeProfileStateDomainsInTransaction(db, {
      expectedRevision: readProfileStateRevision(db),
      replacements: [{ domain: 'settings', payload: '{"theme":"dark"}' }]
    })
  })
  expect(readSurfaceProfileSnapshot(db)).toBe(snapshot)
  expect(readSurfaceOwner(db, readProfileStateRevision(db), request).result).toMatchObject({
    surface: terminal
  })
  expect(() =>
    withProfileStateWriteTransaction(db, () => {
      const domain = readSurfaceProfileDomain(db)
      domain.hosts.local!.surfaces = []
      writeProfileStateDomainsInTransaction(
        db,
        {
          expectedRevision: readProfileStateRevision(db),
          replacements: []
        },
        domain
      )
      throw new Error('rollback staged root')
    })
  ).toThrow('rollback staged root')
  expect(readSurfaceOwner(db, readProfileStateRevision(db), request).result).toMatchObject({
    surface: terminal
  })
  // A replacement root is visible, even on the same connection; removed/bad derived tables cannot prove absence.
  commit((repository) =>
    repository.replaceContent({
      ...key,
      callerId: 'exact-read',
      commandId: 'close',
      expiresAt: 100,
      expected: terminal,
      content: null
    })
  )
  db.exec('DROP TABLE main.workspace_surface_index_meta')
  expect(readSurfaceOwner(db, readProfileStateRevision(db), request).result).toMatchObject({
    surface: { content: null }
  })
  db.close()
  db = openWritableProfileStateDatabase(databasePath, 'test-profile').db
  expect(readSurfaceOwner(db, readProfileStateRevision(db), request).result).toMatchObject({
    surface: { content: null }
  })
})

it('moves hot evidence atomically to generic cold documents and preserves selective, complete and old JSON roundtrips', () => {
  const seeded = commit((repository) => repository.initialize('local', [terminal]))
  const host = seeded.hosts.local!
  const raw = ' { "broken" : true, "spacing": "exact" } '
  host.retainedReferences.push({ workspaceId: 'folder', kind: 'pane', id: 'old', raw })
  host.identityMappings.push({
    workspaceId: 'folder',
    kind: 'host-tab',
    previousId: 'container',
    currentId: 'mapped'
  })
  db.exec(`CREATE TRIGGER fail_cold_insert BEFORE INSERT ON profile_state_documents
    WHEN NEW.domain LIKE 'workspaceSurfaceEvidence/%' BEGIN SELECT RAISE(ABORT, 'preservation failed'); END`)
  const revision = readProfileStateRevision(db)
  expect(() =>
    withProfileStateWriteTransaction(db, () =>
      writeProfileStateDomainsInTransaction(
        db,
        { expectedRevision: revision, replacements: [] },
        structuredClone(seeded)
      )
    )
  ).toThrow('preservation failed')
  expect(readProfileStateRevision(db)).toBe(revision)
  expect(
    db
      .prepare('SELECT count(*) AS n FROM profile_state_documents WHERE domain >= ? AND domain < ?')
      .get(SURFACE_EVIDENCE_PREFIX, `${SURFACE_EVIDENCE_PREFIX}\uffff`)?.n
  ).toBe(0)
  db.exec('DROP TRIGGER fail_cold_insert')
  withProfileStateWriteTransaction(db, () =>
    writeProfileStateDomainsInTransaction(
      db,
      { expectedRevision: revision, replacements: [] },
      seeded
    )
  )
  expect(readSurfaceProfileDomain(db).hosts.local).toMatchObject({
    retainedReferences: [],
    identityMappings: []
  })
  const before = exportProfileStateJson(db)
  const cold = Object.entries(JSON.parse(before))
    .filter(([key]) => key.startsWith(SURFACE_EVIDENCE_PREFIX))
    .map(([key, value]) => [key, surfaceEvidenceDocumentSchema.parse(value)] as const)
  expect(cold).toHaveLength(2)
  expect(cold.some(([, value]) => value.kind === 'reference' && value.value.raw === raw)).toBe(true)
  const [existingKey, existingValue] = cold.find(([, value]) => value.kind === 'reference')!
  const changedEvidence = {
    ...existingValue,
    value: { workspaceId: 'folder', kind: 'pane', id: 'old', raw: 'overwritten' }
  }
  expect(() =>
    withProfileStateWriteTransaction(db, () =>
      writeProfileStateDomainsInTransaction(
        db,
        {
          expectedRevision: readProfileStateRevision(db),
          replacements: [{ domain: existingKey, payload: JSON.stringify(changedEvidence) }]
        },
        readSurfaceProfileDomain(db)
      )
    )
  ).toThrow('Conflicting surface evidence')
  expect(exportProfileStateJson(db)).toBe(before)

  writeProfileStateDomains(db, {
    expectedRevision: readProfileStateRevision(db),
    replacements: [{ domain: 'settings', payload: '{}' }]
  })
  const complete = buildCompleteDocumentReplacements(db, [{ domain: 'settings', payload: '{}' }])
  expect(complete.some(({ domain }) => domain.startsWith(SURFACE_EVIDENCE_PREFIX))).toBe(false)
  writeProfileStateDomains(db, {
    expectedRevision: readProfileStateRevision(db),
    replacements: complete
  })
  expect(
    Object.entries(JSON.parse(exportProfileStateJson(db))).filter(([key]) =>
      key.startsWith(SURFACE_EVIDENCE_PREFIX)
    )
  ).toEqual(cold)
  const roundtrip = exportProfileStateJson(db)
  importProfileStateJson(db, roundtrip)
  expect(
    Object.entries(JSON.parse(exportProfileStateJson(db))).filter(([key]) =>
      key.startsWith(SURFACE_EVIDENCE_PREFIX)
    )
  ).toEqual(cold)
  expect(
    Object.keys(readProfileStateParsedSnapshot(db, { excludeSurfaceEvidence: true }).state).some(
      (key) => key.startsWith(SURFACE_EVIDENCE_PREFIX)
    )
  ).toBe(false)
  const evidence = { ...host, retainedReferences: [], identityMappings: [] }
  attachSurfaceEvidenceReader(db, 'local', evidence)
  const renamed = reserveImportedSurfaceIdentities(
    [terminal],
    [terminal],
    [],
    evidence,
    () => 'minted-other'
  )
  expect(renamed[0]?.hostTabId).toBe('mapped')
})

it.each([10, 100])(
  'protects complete saves without reading %i cold payloads or mapping buckets on warm commands',
  (count) => {
    commit((repository) => repository.initialize('local', [terminal]))
    const host = readSurfaceProfileDomain(db).hosts.local!
    host.retainedReferences = Array.from({ length: count }, (_, index) => ({
      workspaceId: 'other',
      kind: 'pane' as const,
      id: String(index),
      raw: 'x'.repeat(1000)
    }))
    const next = readSurfaceProfileDomain(db)
    next.hosts.local = host
    withProfileStateWriteTransaction(db, () =>
      writeProfileStateDomainsInTransaction(
        db,
        { expectedRevision: readProfileStateRevision(db), replacements: [] },
        next
      )
    )
    const reads: string[] = []
    const prepare = db.prepare.bind(db)
    db.prepare = (sql: string) => {
      reads.push(sql)
      return prepare(sql)
    }
    try {
      buildCompleteDocumentReplacements(db, [{ domain: 'settings', payload: '{}' }])
      executeSurfaceOwnerCommand(db, readProfileStateRevision(db), {
        type: 'query',
        hostId: 'local'
      })
      expect(
        reads.filter((sql) => sql.includes('payload') && sql.includes('domain >= ? AND domain < ?'))
      ).toHaveLength(0)
      expect(reads.length).toBeLessThan(30)
    } finally {
      db.prepare = prepare
    }
  }
)

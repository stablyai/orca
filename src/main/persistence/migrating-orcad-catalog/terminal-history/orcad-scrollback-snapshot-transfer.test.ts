import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import { ORCAD_MIGRATION_MANIFEST_VERSION } from '../../../../shared/orcad-migration/orcad-migration-manifest-validation'
import type { OrcadMigrationManifest } from '../../../../shared/orcad-migration/orcad-migration-manifest'
import type {
  OrcadMigrationSnapshotChunkRequest,
  OrcadMigrationTerminalScrollbackSnapshot
} from '../../../../shared/orcad-migration/orcad-migration-scrollback'
import {
  getTerminalScrollbackSnapshotPath,
  type TerminalScrollbackSnapshotStorage
} from '../../../pty/scrollback/terminal-scrollback-snapshots'
import {
  commitOrcadMigrationSnapshots,
  stageOrcadMigrationSnapshotChunk
} from './orcad-scrollback-snapshot-transfer'

let root: string
let storage: TerminalScrollbackSnapshotStorage

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orcad-migration-snapshots-'))
  storage = { snapshotRoot: join(root, 'terminal-scrollback') }
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('orcad scrollback snapshot transfer', () => {
  it('rejects a same-ref content conflict before materializing any snapshot', () => {
    const firstBytes = Buffer.from('first snapshot', 'utf8')
    const secondBytes = Buffer.from('second snapshot', 'utf8')
    const first = snapshot('4', 'tab-4', 'leaf-4', firstBytes)
    const second = snapshot('5', 'tab-5', 'leaf-5', secondBytes)
    const manifest = migrationManifest('conflict', [first, second])
    const state = stagedState(manifest)
    stage(state, manifest, first, 0, firstBytes)
    stage(state, manifest, second, 0, secondBytes)
    writeFinal(second, Buffer.alloc(secondBytes.length, 0x78))

    expect(() => commitOrcadMigrationSnapshots(manifest, storage)).toThrow(
      `orcad_migration_snapshot_destination_conflict:${second.ref}`
    )
    expect(readFinal(first)).toBeNull()
    expect(readFinal(second)).toEqual(Buffer.alloc(secondBytes.length, 0x78))
  })
})

function snapshot(
  suffix: string,
  tabId: string,
  leafId: string,
  bytes: Buffer
): OrcadMigrationTerminalScrollbackSnapshot {
  return {
    tabId,
    leafId,
    ref: `v1-${suffix.repeat(32)}`,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    byteLength: bytes.length
  }
}

function migrationManifest(
  migrationId: string,
  snapshots: OrcadMigrationTerminalScrollbackSnapshot[]
): OrcadMigrationManifest {
  const workspaceSession = getDefaultWorkspaceSession()
  workspaceSession.terminalLayoutsByTabId = Object.fromEntries(
    snapshots.map((entry) => [
      entry.tabId,
      {
        root: { type: 'leaf' as const, leafId: entry.leafId },
        activeLeafId: entry.leafId,
        expandedLeafId: null,
        scrollbackRefsByLeafId: { [entry.leafId]: entry.ref }
      }
    ])
  )
  return {
    version: ORCAD_MIGRATION_MANIFEST_VERSION,
    migrationId,
    createdAt: '2026-08-30T12:00:00.000Z',
    source: { sshTargetId: 'source', sshTargetGeneration: 1, targetLabel: 'Source' },
    payload: {
      repositories: [],
      projectGroups: [],
      folderWorkspaces: [],
      dormantState: {
        version: 1,
        worktreeMeta: [],
        worktreeLineage: [],
        workspaceLineage: [],
        sparsePresets: [],
        retiredWorktreeNames: [],
        retiredWorktreeNamespaces: [],
        workspaceSession,
        terminalScrollbackSnapshots: snapshots
      }
    },
    manifestSha256: 'a'.repeat(64)
  }
}

function stagedState(...manifests: OrcadMigrationManifest[]): OrcadMigrationManifest[] {
  return manifests
}

function stage(
  state: OrcadMigrationManifest[],
  manifest: OrcadMigrationManifest,
  descriptor: OrcadMigrationTerminalScrollbackSnapshot,
  offset: number,
  bytes: Buffer
) {
  const request: OrcadMigrationSnapshotChunkRequest = {
    migrationId: manifest.migrationId,
    manifestSha256: manifest.manifestSha256,
    ref: descriptor.ref,
    offset,
    bytesBase64: bytes.toString('base64')
  }
  const stagedManifest = state.find((entry) => entry.migrationId === manifest.migrationId) ?? null
  return stageOrcadMigrationSnapshotChunk({ stagedManifest, storage, request })
}

function writeFinal(descriptor: OrcadMigrationTerminalScrollbackSnapshot, bytes: Buffer): void {
  const path = getTerminalScrollbackSnapshotPath(descriptor.ref, storage)
  if (!path) {
    throw new Error('expected snapshot path')
  }
  if (!storage.snapshotRoot) {
    throw new Error('expected snapshot root')
  }
  mkdirSync(storage.snapshotRoot, { recursive: true })
  writeFileSync(path, bytes)
}

function readFinal(descriptor: OrcadMigrationTerminalScrollbackSnapshot): Buffer | null {
  const path = getTerminalScrollbackSnapshotPath(descriptor.ref, storage)
  return path && existsSync(path) ? readFileSync(path) : null
}

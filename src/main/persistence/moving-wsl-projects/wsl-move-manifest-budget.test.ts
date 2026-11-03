import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { computeOrcadMigrationManifestSha256 } from '../../orcad/orcad-migration-manifest-digest'
import { wslMoveCutoverFixture } from '../__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { listWslMoveCutovers, writeWslMoveCutover } from './wsl-move-cutover-journal'
import {
  WSL_MOVE_MANIFEST_REQUEST_BUDGET_BYTES,
  wslMoveManifestRequestBytes
} from './wsl-move-manifest-budget'

let userDataPath: string
beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'wsl-move-budget-'))
})
afterEach(() => {
  rmSync(userDataPath, { recursive: true, force: true })
})

/** A new move whose manifest lands `delta` bytes from the budget. */
function moveSized(delta: number) {
  const base = wslMoveCutoverFixture('move-1', 'prepared')
  const sized = (padding: number) => {
    const { manifestSha256: _digest, ...unsigned } = base.manifest
    const payload = {
      ...unsigned.payload,
      repositories: unsigned.payload.repositories.map((repo) => ({
        ...repo,
        displayName: 'x'.repeat(padding)
      }))
    }
    const signed = { ...unsigned, payload }
    return { ...signed, manifestSha256: computeOrcadMigrationManifestSha256(signed) }
  }
  const overhead = wslMoveManifestRequestBytes(sized(0))
  const manifest = sized(WSL_MOVE_MANIFEST_REQUEST_BUDGET_BYTES - overhead + delta)
  return {
    ...base,
    manifestSha256: manifest.manifestSha256,
    manifest: { ...manifest, source: base.manifest.source }
  }
}

describe('WSL move manifest budget', () => {
  it('records a move right at the budget', () => {
    const move = moveSized(0)
    expect(wslMoveManifestRequestBytes(move.manifest)).toBe(WSL_MOVE_MANIFEST_REQUEST_BUDGET_BYTES)
    writeWslMoveCutover(userDataPath, move)
    expect(listWslMoveCutovers(userDataPath)).toHaveLength(1)
  })

  it('refuses a move one byte over, with a plain message and nothing fenced', () => {
    expect(() => writeWslMoveCutover(userDataPath, moveSized(1))).toThrow(
      /too large to move in one step.*Move fewer projects at a time/
    )
    expect(listWslMoveCutovers(userDataPath)).toEqual([])
  })
})

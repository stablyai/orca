import { existsSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  getRuntimeMetadataPath,
  MAX_RUNTIME_METADATA_FILE_BYTES
} from '../../shared/runtime-bootstrap'
import {
  getServeUpdateHandoffPath,
  MAX_SERVE_UPDATE_HANDOFF_FILE_BYTES
} from '../../shared/serve-update-handoff'
import { readMetadata, tryReadMetadata } from './metadata'
import {
  readServeUpdateHandoff,
  readServeUpdateHandoffSync,
  recordServeUpdateHandoffFailure
} from './serve-update-supervisor'
import { RuntimeClientError } from './types'

describe('CLI runtime control-file bounds', () => {
  const paths: string[] = []

  afterEach(() => {
    for (const path of paths.splice(0)) {
      rmSync(path, { recursive: true, force: true })
    }
  })

  function makeRoot(): string {
    const path = mkdtempSync(join(tmpdir(), 'orca-cli-control-file-bound-'))
    paths.push(path)
    return path
  }

  it('reports oversized runtime metadata as unavailable', () => {
    const root = makeRoot()
    const metadataPath = getRuntimeMetadataPath(root)
    writeFileSync(metadataPath, '{"runtimeId":"runtime-1"}')
    truncateSync(metadataPath, MAX_RUNTIME_METADATA_FILE_BYTES + 1)

    expect(tryReadMetadata(root)).toBeNull()
    expect(() => readMetadata(root)).toThrow(RuntimeClientError)
  })

  it('ignores oversized serve-update handoff state in sync and async readers', async () => {
    const handoffPath = getServeUpdateHandoffPath(makeRoot())
    writeFileSync(handoffPath, '{"schemaVersion":1}')
    truncateSync(handoffPath, MAX_SERVE_UPDATE_HANDOFF_FILE_BYTES + 1)

    expect(readServeUpdateHandoffSync(handoffPath)).toBeNull()
    await expect(readServeUpdateHandoff(handoffPath)).resolves.toBeNull()
  })

  it('preserves the prior handoff when bounded transactional serialization fails', async () => {
    const handoffPath = getServeUpdateHandoffPath(makeRoot())
    const initial = {
      schemaVersion: 1 as const,
      phase: 'install-requested' as const,
      fromVersion: '1.0.0',
      targetVersion: '1.0.1',
      servingPid: process.pid
    }
    writeFileSync(handoffPath, JSON.stringify(initial))

    await expect(
      recordServeUpdateHandoffFailure(
        handoffPath,
        initial,
        'x'.repeat(MAX_SERVE_UPDATE_HANDOFF_FILE_BYTES + 1)
      )
    ).rejects.toThrow(`JSON output exceeds ${MAX_SERVE_UPDATE_HANDOFF_FILE_BYTES} bytes`)

    expect(JSON.parse(readFileSync(handoffPath, 'utf8'))).toEqual(initial)
    expect(existsSync(`${handoffPath}.${process.pid}.tmp`)).toBe(false)
  })
})

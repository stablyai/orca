import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { writeJsonInChunks } from './stats-json-writer'

let tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
  tempDirs = []
})

function getTempFile(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-stats-json-writer-'))
  tempDirs.push(dir)
  return join(dir, name)
}

function expectChunkedWriteToPreserveBytes(name: string, json: string): void {
  const file = getTempFile(name)
  writeJsonInChunks(file, json)
  expect(readFileSync(file)).toEqual(Buffer.from(json, 'utf8'))
}

describe('writeJsonInChunks', () => {
  it('writes large JSON byte-identically', () => {
    const json = JSON.stringify({
      schemaVersion: 1,
      events: Array.from({ length: 2000 }, (_, index) => ({
        type: index % 2 === 0 ? 'agent_start' : 'agent_stop',
        at: 1760000000000 + index,
        meta: {
          ptyId: `pty-${index}`,
          note: 'plain stats payload '.repeat(8)
        }
      })),
      aggregates: {
        totalAgentsSpawned: 1000,
        totalPRsCreated: 0,
        totalAgentTimeMs: 0,
        countedPRs: [],
        firstEventAt: 1760000000000
      }
    })

    expect(Buffer.byteLength(json, 'utf8')).toBeGreaterThan(200_000)
    expectChunkedWriteToPreserveBytes('large.json', json)
  })

  it('preserves multibyte content and surrogate pairs at chunk boundaries', () => {
    const boundaryAstral = `${'a'.repeat(16_383)}😀${'b'.repeat(512)}`
    const multibyteJson = JSON.stringify({
      note: `${boundaryAstral}${'é漢字'.repeat(20_000)}`
    })

    expectChunkedWriteToPreserveBytes('multibyte.json', multibyteJson)
  })
})

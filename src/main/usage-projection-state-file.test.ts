import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  truncateSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  readUsageProjectionStateFile,
  serializeUsageProjectionState,
  UsageProjectionStateCapacityError,
  writeUsageProjectionStateFile,
  writeUsageProjectionStateFileWithRecovery
} from './usage-projection-state-file'

const tempRoots: string[] = []

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('usage projection state files', () => {
  it('accepts exact serialized bytes and rejects the next byte', () => {
    expect(serializeUsageProjectionState('x'.repeat(30), 32)).toHaveLength(32)
    expect(() => serializeUsageProjectionState('x'.repeat(31), 32)).toThrow(
      UsageProjectionStateCapacityError
    )
  })

  it('checks the file size before allocating or decoding it', () => {
    const root = createTempRoot()
    const path = join(root, 'usage.json')
    writeFileSync(path, '{"ok":true}')
    expect(readUsageProjectionStateFile(path, 11)).toBe('{"ok":true}')

    truncateSync(path, 12)
    expect(() => readUsageProjectionStateFile(path, 11)).toThrow('File too large')
    expect(readUsageProjectionStateFile(join(root, 'absent.json'), 11)).toBeNull()
  })

  it('rejects structurally amplified caches before parsing them', () => {
    const root = createTempRoot()
    const path = join(root, 'usage.json')
    const json = '{"rows":[{},{}]}'
    writeFileSync(path, json)

    expect(() =>
      readUsageProjectionStateFile(path, Buffer.byteLength(json), {
        structuralTokens: 7,
        nestingDepth: 3
      })
    ).toThrow('JSON structure')
  })

  it('writes atomically and preserves ordinary JSON semantics', () => {
    const root = createTempRoot()
    const path = join(root, 'nested', 'usage.json')
    const state = { enabled: true, rows: [{ id: 'one' }, { id: 'two' }] }

    writeUsageProjectionStateFile(path, state, 1024)

    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(state)
    expect(readdirSync(join(root, 'nested'))).toEqual(['usage.json'])
  })

  it('replaces an oversized rebuildable projection with a bounded error state', () => {
    const root = createTempRoot()
    const path = join(root, 'usage.json')
    const recovered = writeUsageProjectionStateFileWithRecovery<{
      enabled: boolean
      rows: string | unknown[]
      error?: string
    }>(
      path,
      { enabled: true, rows: 'x'.repeat(200) },
      (error) => ({ enabled: true, rows: [], error: error.message }),
      160
    )

    expect(recovered).toMatchObject({ enabled: true, rows: [] })
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(recovered)
    expect(readdirSync(root)).toEqual(['usage.json'])
  })
})

function createTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-usage-projection-'))
  tempRoots.push(root)
  return root
}

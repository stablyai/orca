import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import type * as NodeFsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { durableWriteTempPath, writeFileDurableIfCurrent } from './durable-file-write'
import { UsageCacheSnapshotWriter } from './usage-cache-snapshot-writer'

const { tempWrites } = vi.hoisted(
  (): {
    tempWrites: { creationMode: number | string | undefined; actualMode: number }[]
  } => ({ tempWrites: [] })
)

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof NodeFsPromises>('node:fs/promises')
  return {
    ...actual,
    open: async (...args: Parameters<typeof NodeFsPromises.open>) => {
      const handle = await actual.open(...args)
      if (typeof args[0] === 'string' && args[0].endsWith('.tmp') && args[1] === 'w') {
        tempWrites.push({ creationMode: args[2], actualMode: (await handle.stat()).mode & 0o777 })
      }
      return handle
    }
  }
})

describe('usage cache snapshot permissions', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-usage-permissions-'))
    tempWrites.length = 0
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  for (const parentMode of [0o700, 0o755]) {
    for (const initialMode of [undefined, 0o600, 0o644]) {
      it.skipIf(process.platform === 'win32')(
        `keeps temp and final files private with parent ${parentMode.toString(8)} and initial ${initialMode?.toString(8) ?? 'absent'}`,
        async () => {
          const parent = join(dir, 'user-data')
          mkdirSync(parent)
          chmodSync(parent, parentMode)
          const final = join(parent, 'orca-claude-usage.json')
          if (initialMode !== undefined) {
            writeFileSync(final, '{"synthetic":"old"}')
            chmodSync(final, initialMode)
          }
          const writer = new UsageCacheSnapshotWriter('[usage-permission-test]', () => final)
          const payload = JSON.stringify({ synthetic: true, sessionId: 'synthetic-session' })

          await writer.write(() => payload)
          await writer.flush()

          // Why: checking the open mode also catches omissions when the runner's umask is 077.
          expect(tempWrites).toEqual([{ creationMode: 0o600, actualMode: 0o600 }])
          expect(statSync(final).mode & 0o777).toBe(0o600)
          expect(statSync(parent).mode & 0o777).toBe(parentMode)
          expect(readFileSync(final, 'utf8')).toBe(payload)
          expect(readdirSync(parent)).toEqual(['orca-claude-usage.json'])

          await writer.write(() => '{"synthetic":"next"}')
          await writer.flush()

          expect(tempWrites).toHaveLength(2)
          expect(tempWrites[1]).toEqual({ creationMode: 0o600, actualMode: 0o600 })
          expect(statSync(final).mode & 0o777).toBe(0o600)
          expect(readFileSync(final, 'utf8')).toBe('{"synthetic":"next"}')
        }
      )
    }
  }

  it.skipIf(process.platform === 'win32')(
    'keeps default modes for callers that omit mode',
    async () => {
      const final = join(dir, 'generic-state.json')
      await writeFileDurableIfCurrent(durableWriteTempPath(final), final, 'synthetic', () => true)

      expect(tempWrites[0]?.creationMode).toBeUndefined()
      expect(statSync(final).mode & 0o777).toBe(0o666 & ~process.umask())
      expect(readFileSync(final, 'utf8')).toBe('synthetic')
    }
  )

  it('still removes an unpublished private temp when the commit is vetoed', async () => {
    const final = join(dir, 'state.json')
    writeFileSync(final, 'synthetic-old')

    const committed = await writeFileDurableIfCurrent(
      durableWriteTempPath(final),
      final,
      'synthetic-new',
      () => false,
      0o600
    )

    expect(committed).toBe(false)
    expect(readFileSync(final, 'utf8')).toBe('synthetic-old')
    expect(readdirSync(dir)).toEqual(['state.json'])
  })
})

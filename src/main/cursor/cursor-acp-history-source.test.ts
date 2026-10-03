import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveCursorAcpHistorySource } from './cursor-acp-history-source'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'orca-cursor-acp-history-'))
  roots.push(root)
  const accountHomePath = join(root, 'cursor-config')
  const cwd = join(root, 'folder-workspace')
  const providerSessionId = 'exact-provider-id'
  const directory = join(accountHomePath, 'acp-sessions', providerSessionId)
  await mkdir(directory, { recursive: true })
  await mkdir(cwd)
  await writeFile(join(directory, 'store.db'), 'protocol fixture database marker')
  await writeFile(join(directory, 'meta.json'), JSON.stringify({ schemaVersion: 1, cwd }))
  return { root, accountHomePath, cwd, providerSessionId, directory }
}

describe('Cursor ACP history adoption source boundary', () => {
  it('accepts an exact ACP store in its configured root and owned folder workspace', async () => {
    const test = await fixture()
    expect(await resolveCursorAcpHistorySource(test)).toBe(join(test.directory, 'store.db'))
    expect(
      await resolveCursorAcpHistorySource({ ...test, cwd: join(test.root, 'another-workspace') })
    ).toBeNull()
  })

  it('never substitutes a terminal conversation store for an ACP session', async () => {
    const test = await fixture()
    await rm(test.directory, { recursive: true })
    const tui = join(test.accountHomePath, 'chats', 'bucket', test.providerSessionId)
    await mkdir(tui, { recursive: true })
    await writeFile(join(tui, 'store.db'), 'terminal fixture store')
    await writeFile(join(tui, 'meta.json'), JSON.stringify({ cwd: test.cwd }))
    expect(await resolveCursorAcpHistorySource(test)).toBeNull()
  })

  it.each(['../outside', '/absolute', 'with/slash', 'with\\slash', '..', ' whitespace '])(
    'rejects path-like provider ID %s',
    async (providerSessionId) => {
      const test = await fixture()
      expect(await resolveCursorAcpHistorySource({ ...test, providerSessionId })).toBeNull()
    }
  )

  it.skipIf(process.platform === 'win32')(
    'refuses directory and database symlink escapes',
    async () => {
      const test = await fixture()
      const outside = join(test.root, 'outside')
      await mkdir(outside)
      await writeFile(join(outside, 'store.db'), 'outside fixture')
      await writeFile(
        join(outside, 'meta.json'),
        JSON.stringify({ schemaVersion: 1, cwd: test.cwd })
      )
      await rm(test.directory, { recursive: true })
      await symlink(outside, test.directory, process.platform === 'win32' ? 'junction' : 'dir')
      expect(await resolveCursorAcpHistorySource(test)).toBeNull()
      await rm(test.directory)
      await mkdir(test.directory)
      await writeFile(
        join(test.directory, 'meta.json'),
        JSON.stringify({ schemaVersion: 1, cwd: test.cwd })
      )
      await symlink(join(outside, 'store.db'), join(test.directory, 'store.db'), 'file')
      expect(await resolveCursorAcpHistorySource(test)).toBeNull()
    }
  )

  it('refuses missing, malformed and oversized metadata', async () => {
    const test = await fixture()
    await rm(join(test.directory, 'meta.json'))
    expect(await resolveCursorAcpHistorySource(test)).toBeNull()
    await writeFile(
      join(test.directory, 'meta.json'),
      JSON.stringify({ schemaVersion: 1, cwd: 'relative-workspace' })
    )
    expect(await resolveCursorAcpHistorySource(test)).toBeNull()
    await writeFile(join(test.directory, 'meta.json'), 'x'.repeat(64 * 1024 + 1))
    expect(await resolveCursorAcpHistorySource(test)).toBeNull()
  })
})

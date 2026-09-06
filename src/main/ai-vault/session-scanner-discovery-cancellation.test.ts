import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { discoverFiles } from './session-scanner-discovery'

it('aborts a discovery while checking file dependencies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-discovery-cancel-'))
  const controller = new AbortController()
  try {
    await writeFile(join(root, 'session.jsonl'), '{}')
    await expect(
      discoverFiles({
        rootDir: root,
        signal: controller.signal,
        limit: 12,
        agent: 'claude',
        issues: [],
        extensions: ['.jsonl'],
        contentDependencyPath: () => {
          controller.abort()
          return undefined
        }
      })
    ).rejects.toMatchObject({ name: 'AbortError' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

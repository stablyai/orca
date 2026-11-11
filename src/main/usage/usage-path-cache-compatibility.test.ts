import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { CODEX_USAGE_SCHEMA_VERSION } from '../codex-usage/codex-usage-provider'
import { OPENCODE_USAGE_SCHEMA_VERSION } from '../opencode-usage/opencode-usage-provider'
import { MUSE_USAGE_SCHEMA_VERSION } from '../muse-usage/muse-usage-provider'
import { readUsageSourceCache } from './usage-source-cache-file'

it.each([
  ['codex', 7, CODEX_USAGE_SCHEMA_VERSION],
  ['opencode', 7, OPENCODE_USAGE_SCHEMA_VERSION],
  ['muse', 2, MUSE_USAGE_SCHEMA_VERSION]
] as const)(
  'discards %s source projections with the former WSL path keys',
  async (provider, previousSchema, schemaVersion) => {
    const root = await mkdtemp(join(tmpdir(), 'orca-usage-path-cache-'))
    try {
      const path = join(root, `${provider}.json`)
      await writeFile(
        path,
        JSON.stringify({
          schemaVersion: previousSchema,
          worktreeFingerprint: '[]',
          sources: [
            {
              path: 'old-source',
              sessions: [{ projectKey: 'cwd://wsl.localhost/ubuntu/home/be0h/repo' }]
            }
          ]
        })
      )
      expect(
        await readUsageSourceCache({ path, schemaVersion, worktreeFingerprint: '[]', reuse: true })
      ).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)

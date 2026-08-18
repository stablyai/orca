import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import { discoverCursorLegacy } from './session-scanner-cursor-legacy-discovery'
import { cursorLegacySlug } from './session-scanner-cursor-paths'

const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Cursor legacy scope bounds', () => {
  it('caps relevant paths per storage namespace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-cursor-legacy-scope-'))
    tempRoots.push(root)
    const projectsDir = join(root, '.cursor', 'projects')
    const scopePath = join(root, 'workspace')
    const transcript = join(
      projectsDir,
      cursorLegacySlug(scopePath),
      'agent-transcripts',
      'session',
      'session.jsonl'
    )
    await mkdir(join(transcript, '..'), { recursive: true })
    await writeFile(transcript, '{}\n')
    const irrelevantWslPaths = Array.from(
      { length: 64 },
      (_, index) => `\\\\wsl.localhost\\Ubuntu\\home\\ada\\repo-${index}`
    )

    const result = await discoverCursorLegacy({
      roots: { projectsDir, storageContextKey: 'native', targetPlatform: 'linux' },
      options: { scopePaths: [...irrelevantWslPaths, scopePath] },
      limit: 10,
      issues: []
    })

    expect(result.cursorCwdEvidenceByPath?.has(transcript)).toBe(true)
  })

  it('reports truncation after filtering and deduplicating the namespace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-cursor-legacy-scope-limit-'))
    tempRoots.push(root)
    const issues: AiVaultScanIssue[] = []

    await discoverCursorLegacy({
      roots: {
        projectsDir: join(root, '.cursor', 'projects'),
        storageContextKey: 'native',
        targetPlatform: 'linux'
      },
      options: {
        scopePaths: Array.from({ length: 65 }, (_, index) => `/home/ada/repo-${index}`)
      },
      limit: 10,
      issues
    })

    expect(issues).toContainEqual(
      expect.objectContaining({
        message: 'Cursor legacy discovery reached its 64-path scope limit.'
      })
    )
  })
})

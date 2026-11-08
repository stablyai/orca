import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MARINE_CREATURES } from '../../../../shared/marine-creatures'
import { encodeClaudeProjectPath } from '../../../ai-vault/scanners/claude/claude-project-dir-encoding'
import { resetProjectDirCwdCacheForTests } from '../../../ai-vault/session-scanner-scope-discovery'
import { discoverRetiredWorktreeNames } from './worktree-retirement-discovery'

const FIRST = MARINE_CREATURES[0].toLowerCase()

describe('retirement discovery of Claude buckets', () => {
  let home: string

  beforeEach(async () => {
    resetProjectDirCwdCacheForTests()
    home = await mkdtemp(join(tmpdir(), 'orca-retire-claude-'))
  })

  afterEach(async () => {
    await rm(home, { force: true, recursive: true })
  })

  // Claude Code cuts a long bucket name to `<first 200>-<hash>`; only the transcript cwd names the workspace.
  async function addHashedBucket(cwd: string): Promise<void> {
    const bucket = join(
      home,
      '.claude',
      'projects',
      `${encodeClaudeProjectPath(cwd).slice(0, 200)}-1x2y3z`
    )
    await mkdir(bucket, { recursive: true })
    await writeFile(join(bucket, 'session.jsonl'), `${JSON.stringify({ type: 'user', cwd })}\n`)
  }

  it.each([
    ['the cut falls inside the workspace name', 195],
    ['the workspace root alone is longer than the cut', 230]
  ])('keeps a long workspace path spent when %s', async (_case, rootLength) => {
    const root = `/synthetic/${'a'.repeat(rootLength - '/synthetic/'.length)}`
    await addHashedBucket(`${root}/${FIRST}`)

    const retired = await discoverRetiredWorktreeNames({ workspaceRoots: [root], home, env: {} })

    expect(retired).toEqual({ names: new Set([FIRST]), complete: true })
  })
})

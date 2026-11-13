import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { encodeClaudeProjectPaths } from '../ai-vault/scanners/claude/claude-project-dir-encoding'
import { findClaudeTranscriptBySessionIdContent } from './claude-transcript-content-lookup'

async function makeProjects(): Promise<{
  root: string
  workspaceCwd: string
  bucketDir: string
  cleanup: () => Promise<void>
}> {
  const root = await mkdtemp(join(tmpdir(), 'claude-content-lookup-'))
  const workspaceCwd = join(root, 'workspace')
  const bucketDir = join(root, 'projects', encodeClaudeProjectPaths(workspaceCwd)[0]!)
  await mkdir(bucketDir, { recursive: true })
  return {
    root,
    workspaceCwd,
    bucketDir,
    cleanup: () => rm(root, { recursive: true, force: true })
  }
}

it('finds a transcript whose filename differs from the provider session id', async () => {
  const rig = await makeProjects()
  try {
    const file = join(rig.bucketDir, 'renamed-transcript.jsonl')
    await writeFile(
      file,
      [
        JSON.stringify({ type: 'summary', summary: 'saved conversation' }),
        JSON.stringify({ type: 'user', sessionId: 'session-1', message: { content: 'hi' } })
      ].join('\n')
    )

    await expect(
      findClaudeTranscriptBySessionIdContent({
        projectsDir: join(rig.root, 'projects'),
        workspaceCwd: rig.workspaceCwd,
        providerSessionId: 'session-1'
      })
    ).resolves.toBe(file)
  } finally {
    await rig.cleanup()
  }
})

it('does not claim a transcript that belongs to another session', async () => {
  const rig = await makeProjects()
  try {
    await writeFile(
      join(rig.bucketDir, 'other.jsonl'),
      JSON.stringify({ type: 'user', sessionId: 'session-2' })
    )

    await expect(
      findClaudeTranscriptBySessionIdContent({
        projectsDir: join(rig.root, 'projects'),
        workspaceCwd: rig.workspaceCwd,
        providerSessionId: 'session-1'
      })
    ).resolves.toBeNull()
  } finally {
    await rig.cleanup()
  }
})

it('also searches the bucket of a parent directory the CLI may have started in', async () => {
  const rig = await makeProjects()
  try {
    const childCwd = join(rig.workspaceCwd, 'packages', 'app')
    const parentBucket = join(rig.root, 'projects', encodeClaudeProjectPaths(rig.workspaceCwd)[0]!)
    await mkdir(parentBucket, { recursive: true })
    const file = join(parentBucket, 'started-in-parent.jsonl')
    await writeFile(file, JSON.stringify({ type: 'user', sessionId: 'session-parent' }))

    await expect(
      findClaudeTranscriptBySessionIdContent({
        projectsDir: join(rig.root, 'projects'),
        workspaceCwd: childCwd,
        providerSessionId: 'session-parent'
      })
    ).resolves.toBe(file)
  } finally {
    await rig.cleanup()
  }
})

it('refuses to call an unreadable candidate absent in strict adoption', async () => {
  const rig = await makeProjects()
  try {
    // A directory named like a transcript cannot be read as one on any platform.
    await mkdir(join(rig.bucketDir, 'unreadable.jsonl'))

    await expect(
      findClaudeTranscriptBySessionIdContent({
        projectsDir: join(rig.root, 'projects'),
        workspaceCwd: rig.workspaceCwd,
        providerSessionId: 'session-1',
        strictErrors: true
      })
    ).rejects.toThrow('cannot be proven absent')
    // A non-strict lookup keeps its old null for the same bucket.
    await expect(
      findClaudeTranscriptBySessionIdContent({
        projectsDir: join(rig.root, 'projects'),
        workspaceCwd: rig.workspaceCwd,
        providerSessionId: 'session-1',
        strictErrors: false
      })
    ).resolves.toBeNull()
  } finally {
    await rig.cleanup()
  }
})

it('treats a readable transcript with no rows as empty history, not unreadable, in strict adoption', async () => {
  const rig = await makeProjects()
  try {
    await writeFile(join(rig.bucketDir, 'zero-byte.jsonl'), '')
    await writeFile(join(rig.bucketDir, 'blank-only.jsonl'), ' \n\t\n')

    await expect(
      findClaudeTranscriptBySessionIdContent({
        projectsDir: join(rig.root, 'projects'),
        workspaceCwd: rig.workspaceCwd,
        providerSessionId: 'session-1',
        strictErrors: true
      })
    ).resolves.toBeNull()
  } finally {
    await rig.cleanup()
  }
})

it('matches the row-level session id, not a nested payload session id', async () => {
  const rig = await makeProjects()
  try {
    const file = join(rig.bucketDir, 'nested-session.jsonl')
    await writeFile(
      file,
      JSON.stringify({
        type: 'user',
        message: { sessionId: 'another-session' },
        sessionId: 'session-1'
      })
    )

    await expect(
      findClaudeTranscriptBySessionIdContent({
        projectsDir: join(rig.root, 'projects'),
        workspaceCwd: rig.workspaceCwd,
        providerSessionId: 'session-1'
      })
    ).resolves.toBe(file)
  } finally {
    await rig.cleanup()
  }
})

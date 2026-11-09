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

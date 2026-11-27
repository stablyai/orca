import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scanAntigravityUsageFiles } from './scanner'

const tempDirs: string[] = []

async function createTempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'orca-agy-usage-'))
  tempDirs.push(dir)
  return dir
}

async function writeJsonl(filePath: string, rows: unknown[]): Promise<void> {
  await mkdir(join(filePath, '..'), { recursive: true })
  await writeFile(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8')
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) {
      await rm(dir, { recursive: true, force: true })
    }
  }
})

describe('scanAntigravityUsageFiles', () => {
  it('aggregates measured steps, replaces amended step_index, rolls subagents into parent worktrees, and deduplicates copied roots', async () => {
    const root = await createTempRoot()
    const repoPath = join(root, 'workspace', 'orca')
    await mkdir(repoPath, { recursive: true })

    const cliAppDir = join(root, '.gemini', 'antigravity-cli')
    const cliBrainDir = join(cliAppDir, 'brain')
    const copiedBrainDir = join(root, 'copied-home', 'antigravity-acp', 'brain')
    const symlinkBrainDir = join(root, 'symlink-brain')

    const parentId = '11111111-1111-4111-8111-111111111111'
    const childId = '22222222-2222-4222-8222-222222222222'
    const acpSessionId = '33333333-3333-4333-8333-333333333333'

    await writeJsonl(join(cliAppDir, 'history.jsonl'), [
      {
        conversationId: parentId,
        display: 'Implement usage stats',
        timestamp: '2026-11-26T10:00:00Z',
        workspace: repoPath
      }
    ])

    const parentRecords = [
      {
        step_index: 0,
        type: 'USER_INPUT',
        created_at: '2026-11-26T10:00:00Z',
        content: '<USER_REQUEST>\nImplement usage stats\n</USER_REQUEST>'
      },
      // Amended step_index 1: the initial draft must be replaced by the later DONE record.
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-26T10:00:05Z',
        model: 'gemini-4-carbon-high',
        input_tokens: 999,
        cache_read_tokens: 999,
        output_tokens: 999
      },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-26T10:00:06Z',
        model: 'gemini-4-carbon-high',
        input_tokens: 100,
        cache_read_tokens: 400,
        output_tokens: 50,
        thinking_output_tokens: 20
      },
      // Unmeasured legacy planner step must be ignored rather than estimated from text length.
      {
        step_index: 2,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-26T10:00:10Z',
        content: 'Legacy step with no token fields'
      },
      {
        step_index: 3,
        type: 'GENERIC',
        status: 'DONE',
        created_at: '2026-11-26T10:00:15Z',
        content: `Created the following subagent:\n{\n  "conversationId": "${childId}"\n}`
      }
    ]

    await writeJsonl(
      join(cliBrainDir, parentId, '.system_generated', 'logs', 'transcript.jsonl'),
      parentRecords
    )
    // Sibling transcript_full.jsonl in the same conversation must not double-count.
    await writeJsonl(
      join(cliBrainDir, parentId, '.system_generated', 'logs', 'transcript_full.jsonl'),
      parentRecords
    )
    // Copied transcript in a second root must lose event-key ownership to the primary root.
    await writeJsonl(
      join(copiedBrainDir, parentId, '.system_generated', 'logs', 'transcript.jsonl'),
      parentRecords
    )

    // Subagent has no history.jsonl entry of its own; it must inherit parentId and repoPath.
    await writeJsonl(join(cliBrainDir, childId, '.system_generated', 'logs', 'transcript.jsonl'), [
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-26T10:01:00Z',
        model: 'gemini-4-hydrogen-tiered-high',
        input_tokens: 30,
        cache_read_tokens: 70,
        output_tokens: 15
      }
    ])

    // Managed ACP session resolves cwd from conversations/<id>.meta and handles omitted model.
    const acpMetaPath = join(
      root,
      'copied-home',
      'antigravity-acp',
      'conversations',
      `${acpSessionId}.meta`
    )
    await mkdir(join(acpMetaPath, '..'), { recursive: true })
    await writeFile(acpMetaPath, JSON.stringify({ cwd: repoPath }), 'utf8')
    await writeJsonl(
      join(copiedBrainDir, acpSessionId, '.system_generated', 'logs', 'transcript_full.jsonl'),
      [
        {
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: '2026-11-26T11:00:00Z',
          input_tokens: 200,
          cache_read_tokens: 0,
          output_tokens: 40
        }
      ]
    )

    await symlink(cliBrainDir, symlinkBrainDir)

    const worktrees = [
      {
        repoId: 'repo-orca',
        worktreeId: 'wt-orca',
        path: repoPath,
        displayName: 'orca'
      }
    ]

    const first = await scanAntigravityUsageFiles(worktrees, [], undefined, [
      cliBrainDir,
      symlinkBrainDir,
      copiedBrainDir
    ])

    expect(first.sessions).toHaveLength(2)
    const parentSession = first.sessions.find((session) => session.sessionId === parentId)
    const acpSession = first.sessions.find((session) => session.sessionId === acpSessionId)

    expect(parentSession).toMatchObject({
      sessionId: parentId,
      primaryWorktreeId: 'wt-orca',
      primaryRepoId: 'repo-orca',
      eventCount: 2,
      // (100 + 400) + (30 + 70) = 600 total input, 470 cached, 65 output, 20 reasoning, 665 total
      totalInputTokens: 600,
      totalCachedInputTokens: 470,
      totalOutputTokens: 65,
      totalReasoningOutputTokens: 20,
      totalTokens: 665
    })
    expect(acpSession).toMatchObject({
      sessionId: acpSessionId,
      primaryWorktreeId: 'wt-orca',
      primaryModel: 'Unknown model',
      eventCount: 1,
      totalInputTokens: 200,
      totalCachedInputTokens: 0,
      totalOutputTokens: 40,
      totalTokens: 240
    })

    // Warm scan with unchanged files must preserve subagent linkage and totals without rereading.
    let rereadFiles = 0
    const warm = await scanAntigravityUsageFiles(
      worktrees,
      first.processedFiles,
      (count) => {
        rereadFiles += count
      },
      [cliBrainDir, copiedBrainDir]
    )
    expect(rereadFiles).toBe(0)
    expect(warm.sessions).toEqual(first.sessions)
    expect(warm.dailyAggregates).toEqual(first.dailyAggregates)
  })
})

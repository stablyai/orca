import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as transcriptFilesystem from '../../../native-chat/transcript-filesystem/wsl-transcript-fs-access'
import { listPiSubagentSessions } from './session-scanner-pi-subagent-listing'
import { countPiSubagentTranscripts } from './session-scanner-pi-subagent-transcripts'

const filesystem = vi.hoisted(() => ({ readdir: vi.fn(), actualReaddir: vi.fn() }))

// Real readdir unless a test forces a failure, so unreadable directories can be exercised.
vi.mock('../../../native-chat/transcript-filesystem/wsl-transcript-fs-access', async (original) => {
  const actual = await original<typeof transcriptFilesystem>()
  filesystem.actualReaddir.mockImplementation(actual.wslGatedReaddir)
  filesystem.readdir.mockImplementation(filesystem.actualReaddir)
  return { ...actual, wslGatedReaddir: filesystem.readdir }
})

const PARENT_STEM = '2026-05-01T10-00-00-000Z_cccccccc-dddd-4eee-8fff-000000000000'
const PARENT_SESSION_ID = 'cccccccc-dddd-4eee-8fff-000000000000'
const CHILD_SESSION_ID = '11111111-2222-4333-8444-555555555555'

let tempRoots: string[] = []

afterEach(async () => {
  filesystem.readdir.mockImplementation(filesystem.actualReaddir)
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

function childTranscript(args: {
  id: string
  timestamp: string
  prompt: string
  parentFilePath: string
}): string {
  return [
    JSON.stringify({
      type: 'session',
      version: 3,
      id: args.id,
      cwd: '/repo/app',
      timestamp: args.timestamp,
      parentSession: args.parentFilePath
    }),
    JSON.stringify({
      type: 'message',
      timestamp: args.timestamp,
      message: { role: 'user', content: args.prompt }
    })
  ].join('\n')
}

describe('listPiSubagentSessions', () => {
  it('lists the child sessions pi-subagents wrote under the parent transcript stem', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'orca-pi-subagent-list-'))
    tempRoots.push(workspace)
    const parentPath = join(workspace, `${PARENT_STEM}.jsonl`)
    await writeFile(parentPath, '')
    const firstChildPath = join(
      workspace,
      PARENT_STEM,
      'd4306da3-ab96-4236-bf98-8865dc4ce978',
      'run-0',
      'session.jsonl'
    )
    const secondChildPath = join(
      workspace,
      PARENT_STEM,
      '4684f05a-d72d-4cdf-9e88-0adc2d16a31c',
      'run-0',
      'session.jsonl'
    )
    await mkdir(join(firstChildPath, '..'), { recursive: true })
    await mkdir(join(secondChildPath, '..'), { recursive: true })
    await writeFile(
      firstChildPath,
      childTranscript({
        id: CHILD_SESSION_ID,
        timestamp: '2026-05-01T10:01:00.000Z',
        prompt: 'Map the auth surface',
        parentFilePath: parentPath
      })
    )
    await writeFile(
      secondChildPath,
      childTranscript({
        id: '66666666-7777-4888-8999-000000000000',
        timestamp: '2026-05-01T10:02:00.000Z',
        prompt: 'Read the DC API spec',
        parentFilePath: parentPath
      })
    )

    const result = await listPiSubagentSessions({ parentFilePath: parentPath, platform: 'darwin' })

    expect(result.issues).toEqual([])
    expect(
      result.sessions.map((session) => ({
        title: session.title,
        parent: session.subagent?.parentSessionId,
        filePath: session.filePath
      }))
    ).toEqual([
      { title: 'Read the DC API spec', parent: PARENT_SESSION_ID, filePath: secondChildPath },
      { title: 'Map the auth surface', parent: PARENT_SESSION_ID, filePath: firstChildPath }
    ])
    await expect(countPiSubagentTranscripts(parentPath)).resolves.toBe(2)
  })

  it('resolves empty for a session that never delegated', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'orca-pi-subagent-list-'))
    tempRoots.push(workspace)
    const parentPath = join(workspace, `${PARENT_STEM}.jsonl`)
    await writeFile(parentPath, '')

    await expect(
      listPiSubagentSessions({ parentFilePath: parentPath, platform: 'darwin' })
    ).resolves.toEqual({ sessions: [], issues: [] })
    await expect(countPiSubagentTranscripts(parentPath)).resolves.toBe(0)
  })

  it('names a child by its session record when the parent is itself a session.jsonl child', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'orca-pi-subagent-list-'))
    tempRoots.push(workspace)
    const topLevelParentPath = join(workspace, `${PARENT_STEM}.jsonl`)
    const childPath = join(
      workspace,
      PARENT_STEM,
      'd4306da3-ab96-4236-bf98-8865dc4ce978',
      'run-0',
      'session.jsonl'
    )
    const grandchildPath = join(
      join(childPath, '..'),
      'session',
      '4684f05a-d72d-4cdf-9e88-0adc2d16a31c',
      'run-0',
      'session.jsonl'
    )
    await mkdir(join(childPath, '..'), { recursive: true })
    await mkdir(join(grandchildPath, '..'), { recursive: true })
    await writeFile(topLevelParentPath, '')
    await writeFile(
      childPath,
      childTranscript({
        id: CHILD_SESSION_ID,
        timestamp: '2026-05-01T10:01:00.000Z',
        prompt: 'Map the auth surface',
        parentFilePath: topLevelParentPath
      })
    )
    await writeFile(
      grandchildPath,
      childTranscript({
        id: '66666666-7777-4888-8999-000000000000',
        timestamp: '2026-05-01T10:02:00.000Z',
        prompt: 'Read the DC API spec',
        parentFilePath: childPath
      })
    )

    const result = await listPiSubagentSessions({ parentFilePath: childPath, platform: 'darwin' })

    expect(result.sessions.map((session) => session.subagent?.parentSessionId)).toEqual([
      CHILD_SESSION_ID
    ])
  })

  it('reports an unreadable child directory instead of showing no subagents', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'orca-pi-subagent-list-'))
    tempRoots.push(workspace)
    const parentPath = join(workspace, `${PARENT_STEM}.jsonl`)
    await writeFile(parentPath, '')
    filesystem.readdir.mockRejectedValueOnce(Object.assign(new Error('EIO'), { code: 'EIO' }))

    const result = await listPiSubagentSessions({ parentFilePath: parentPath, platform: 'darwin' })

    expect(result.sessions).toEqual([])
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0]).toMatchObject({ agent: 'pi', path: join(workspace, PARENT_STEM) })
  })

  it('keeps the children it found when a nested directory fails to read', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'orca-pi-subagent-list-'))
    tempRoots.push(workspace)
    const parentPath = join(workspace, `${PARENT_STEM}.jsonl`)
    const childPath = join(
      workspace,
      PARENT_STEM,
      'd4306da3-ab96-4236-bf98-8865dc4ce978',
      'run-0',
      'session.jsonl'
    )
    const unreadableRunDir = join(
      workspace,
      PARENT_STEM,
      '4684f05a-d72d-4cdf-9e88-0adc2d16a31c',
      'run-0'
    )
    await mkdir(join(childPath, '..'), { recursive: true })
    await mkdir(unreadableRunDir, { recursive: true })
    await writeFile(parentPath, '')
    await writeFile(
      childPath,
      childTranscript({
        id: CHILD_SESSION_ID,
        timestamp: '2026-05-01T10:01:00.000Z',
        prompt: 'Map the auth surface',
        parentFilePath: parentPath
      })
    )
    const actualReaddir = filesystem.actualReaddir
    filesystem.readdir.mockImplementation((path: string, ...rest: unknown[]) =>
      path === unreadableRunDir
        ? Promise.reject(Object.assign(new Error('EACCES'), { code: 'EACCES' }))
        : actualReaddir(path, ...rest)
    )

    const result = await listPiSubagentSessions({ parentFilePath: parentPath, platform: 'darwin' })

    expect(result.sessions.map((session) => session.sessionId)).toEqual([CHILD_SESSION_ID])
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0]).toMatchObject({ agent: 'pi', path: unreadableRunDir })
  })
})

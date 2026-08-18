import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ActiveSpan } from '../observability/tracer'
import { discoverCursorLegacy } from './session-scanner-cursor-legacy-discovery'
import { recordLocalCursorDiscoverySpan } from './session-scanner-cursor-observability'
import { cursorLegacySlug } from './session-scanner-cursor-paths'

let tempRoot: string | null = null

afterEach(async () => {
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true })
    tempRoot = null
  }
})

describe('Cursor discovery observability', () => {
  it('includes bounded legacy work and truncation in local scan telemetry', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'orca-cursor-legacy-span-'))
    const workspace = join(tempRoot, 'workspace')
    const projectsDir = join(tempRoot, 'projects')
    const transcript = join(
      projectsDir,
      cursorLegacySlug(workspace),
      'agent-transcripts',
      'session',
      'session.jsonl'
    )
    await Promise.all([mkdir(workspace), mkdir(join(transcript, '..'), { recursive: true })])
    await writeFile(transcript, '{}\n')

    const discovery = await discoverCursorLegacy({
      roots: { projectsDir, storageContextKey: 'local', targetPlatform: 'linux' },
      options: { scopePaths: [workspace], platform: 'linux' },
      limit: 10,
      issues: []
    })

    expect(discovery.cursorLegacyDiscoveryCounters).toEqual({
      directoryReaddir: 6,
      direntsRead: 6,
      fileStat: 2,
      scopeRealpath: 1
    })
    expect(discovery.cursorLegacyDiscoveryTruncated).toEqual({ entries: false, files: false })

    const setAttribute = vi.fn()
    recordLocalCursorDiscoverySpan({ setAttribute } as unknown as ActiveSpan, [discovery])
    expect(setAttribute).toHaveBeenCalledWith('cursorLocalFilesystemOperations', 15)
    expect(setAttribute).toHaveBeenCalledWith('cursorLocalLegacyDirectoryReaddir', 6)
    expect(setAttribute).toHaveBeenCalledWith('cursorLocalLegacyDirentsRead', 6)
    expect(setAttribute).toHaveBeenCalledWith('cursorLocalLegacyFileStat', 2)
    expect(setAttribute).toHaveBeenCalledWith('cursorLocalLegacyScopeRealpath', 1)
    expect(setAttribute).toHaveBeenCalledWith('cursorLocalLegacyTruncatedEntries', false)
    expect(setAttribute).toHaveBeenCalledWith('cursorLocalLegacyTruncatedFiles', false)
  })
})

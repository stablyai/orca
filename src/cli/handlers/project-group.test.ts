import { resolve as resolvePath } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { REPEATED_FLAG_SEPARATOR } from '../args'
import type { HandlerContext } from '../dispatch'
import type { RuntimeClient } from '../runtime-client'
import { PROJECT_GROUP_HANDLERS } from './project-group'

const callMock = vi.fn()

function context(
  flags: [string, string | boolean][],
  options: { cwd?: string; isRemote?: boolean; json?: boolean } = {}
): HandlerContext {
  return {
    flags: new Map(flags),
    cwd: options.cwd ?? '/workspace',
    json: options.json ?? false,
    client: {
      isRemote: options.isRemote ?? false,
      call: callMock
    } as unknown as RuntimeClient
  }
}

describe('project-group CLI handlers', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    callMock.mockReset()
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  it('resolves a local scan path and calls the existing scan RPC', async () => {
    callMock.mockResolvedValue({
      id: 'scan-1',
      ok: true,
      result: {
        selectedPath: '/workspace/root',
        selectedPathKind: 'non_git_folder',
        repos: [],
        truncated: false,
        timedOut: false,
        stopped: false,
        durationMs: 5,
        maxDepth: 4,
        maxRepos: 100,
        timeoutMs: 15_000
      },
      _meta: { runtimeId: 'runtime-1' }
    })

    await PROJECT_GROUP_HANDLERS['project-group scan-nested'](context([['path', 'root']]))

    expect(callMock).toHaveBeenCalledWith('projectGroup.scanNested', {
      path: resolvePath('/workspace', 'root')
    })
  })

  it('maps repeated local project paths to the existing import RPC', async () => {
    callMock.mockResolvedValue({
      id: 'import-1',
      ok: true,
      result: {
        projects: [],
        importedCount: 0,
        alreadyKnownCount: 0,
        failedCount: 0
      },
      _meta: { runtimeId: 'runtime-1' }
    })

    await PROJECT_GROUP_HANDLERS['project-group import-nested'](
      context([
        ['path', '.'],
        ['project-path', `repos/api${REPEATED_FLAG_SEPARATOR}repos/web`],
        ['mode', 'group'],
        ['group-name', 'task-workspace']
      ])
    )

    expect(callMock).toHaveBeenCalledWith('projectGroup.importNested', {
      parentPath: resolvePath('/workspace'),
      groupName: 'task-workspace',
      projectPaths: [
        resolvePath('/workspace', 'repos/api'),
        resolvePath('/workspace', 'repos/web')
      ],
      mode: 'group'
    })
  })

  it('rejects missing project paths before calling the runtime', async () => {
    await expect(
      PROJECT_GROUP_HANDLERS['project-group import-nested'](
        context([
          ['path', '.'],
          ['mode', 'group']
        ])
      )
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message: expect.stringContaining('Missing required --project-path')
    })
    expect(callMock).not.toHaveBeenCalled()
  })

  it('rejects unsupported import modes before calling the runtime', async () => {
    await expect(
      PROJECT_GROUP_HANDLERS['project-group import-nested'](
        context([
          ['path', '.'],
          ['project-path', 'repos/api'],
          ['mode', 'merge']
        ])
      )
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message: 'Invalid --mode. Use group or separate.'
    })
    expect(callMock).not.toHaveBeenCalled()
  })

  it('requires each remote project path to be absolute', async () => {
    await expect(
      PROJECT_GROUP_HANDLERS['project-group import-nested'](
        context(
          [
            ['path', '/srv/workspace'],
            ['project-path', 'repos/api'],
            ['mode', 'separate']
          ],
          { isRemote: true }
        )
      )
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message:
        'Remote nested repository requires --project-path to be an absolute path on the remote server.'
    })
    expect(callMock).not.toHaveBeenCalled()
  })
})

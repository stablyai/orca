import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { DeviceRegistry } from './device-registry'
import { createMobileRpcSurfaceRuntime } from './runtime-rpc-mobile-method-allowlist-fixtures'

/** Every Source Control write the page reaches through the generic host lane, with the runtime
 * call each one must land on. The shell rewrote the page handle into `worktree`; nothing else in
 * the request may choose the workspace. */
const MUTATIONS: [string, string, Record<string, unknown>, unknown[]][] = [
  ['git.stage', 'stageRuntimeGitPath', { filePath: 'src/app.ts' }, ['id:bound', 'src/app.ts']],
  [
    'git.bulkStage',
    'bulkStageRuntimeGitPaths',
    { filePaths: ['src/app.ts'] },
    ['id:bound', ['src/app.ts']]
  ],
  ['git.unstage', 'unstageRuntimeGitPath', { filePath: 'src/app.ts' }, ['id:bound', 'src/app.ts']],
  [
    'git.bulkUnstage',
    'bulkUnstageRuntimeGitPaths',
    { filePaths: ['src/app.ts'] },
    ['id:bound', ['src/app.ts']]
  ],
  ['git.discard', 'discardRuntimeGitPath', { filePath: 'src/app.ts' }, ['id:bound', 'src/app.ts']],
  [
    'git.bulkDiscard',
    'bulkDiscardRuntimeGitPaths',
    { filePaths: ['src/app.ts'] },
    ['id:bound', ['src/app.ts']]
  ],
  ['git.commit', 'commitRuntimeGit', { message: 'feat: mobile' }, ['id:bound', 'feat: mobile']],
  ['git.checkout', 'checkoutRuntimeGitBranch', { branch: 'main' }, ['id:bound', 'main']],
  ['git.fetch', 'fetchRuntimeGit', {}, ['id:bound']],
  ['git.pull', 'pullRuntimeGit', {}, ['id:bound']],
  ['git.fastForward', 'fastForwardRuntimeGit', {}, ['id:bound']],
  ['git.push', 'pushRuntimeGit', { publish: true }, ['id:bound', true]],
  ['git.rebaseFromBase', 'rebaseRuntimeGitFromBase', { baseRef: 'main' }, ['id:bound', 'main']],
  ['git.abortMerge', 'abortRuntimeGitMerge', {}, ['id:bound']],
  ['git.abortRebase', 'abortRuntimeGitRebase', {}, ['id:bound']],
  [
    'files.openDiff',
    'openMobileDiff',
    { relativePath: 'src/app.ts', staged: true },
    ['id:bound', 'src/app.ts', true]
  ]
]

it('binds every page-reachable Source Control write to the shell-supplied worktree', async () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-mobile-source-control-'))
  const { runtime } = createMobileRpcSurfaceRuntime()
  const calls = new Map<string, ReturnType<typeof vi.fn>>()
  for (const [, runtimeMethod] of MUTATIONS) {
    const spy = vi.fn().mockResolvedValue({ ok: true, branch: 'main', success: true })
    calls.set(runtimeMethod, spy)
    Object.assign(runtime, { [runtimeMethod]: spy })
  }
  const server = new OrcaRuntimeRpcServer({ runtime, userDataPath, enableWebSocket: false })
  server['deviceRegistry'] = new DeviceRegistry(userDataPath)
  const mobile = server['deviceRegistry']!.addDevice('phone', 'mobile')
  async function dispatch(method: string, params: unknown) {
    const responses: { ok: boolean; error?: { code: string } }[] = []
    await server['handleWebSocketMessage'](
      JSON.stringify({ id: 'request', method, params, deviceToken: mobile.token }),
      (response) => responses.push(JSON.parse(response)),
      () => {}
    )
    return responses[0]!
  }
  try {
    for (const [method, runtimeMethod, params, expected] of MUTATIONS) {
      // A second workspace field in the body must not redirect the write.
      const response = await dispatch(method, {
        ...params,
        worktree: 'id:bound',
        worktreeId: 'id:other',
        workspaceId: 'other'
      })
      expect(response.error, method).toBeUndefined()
      expect(
        calls.get(runtimeMethod)!.mock.calls.at(-1)?.slice(0, expected.length),
        method
      ).toEqual(expected)
    }
  } finally {
    await server.stop()
    rmSync(userDataPath, { recursive: true, force: true })
  }
})

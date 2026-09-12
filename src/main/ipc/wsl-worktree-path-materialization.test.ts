import { describe, expect, it, vi } from 'vitest'
import {
  inspectWslWorktreeSharedLinks,
  buildWslWorktreeMaterializationScript,
  materializeWslWorktreePaths
} from './wsl-worktree-path-materialization'
import { runProcess } from '../../shared/child-process/run-process'

const result = {
  code: 0,
  stdout: '{"supported":true}',
  stderr: '',
  timedOut: false,
  environmentResolved: true
}

describe('WSL materialization routing', () => {
  it('dispatches converted paths on the selected distro', async () => {
    const run = vi.fn().mockResolvedValue(result)
    await expect(
      materializeWslWorktreePaths('Ubuntu', 'C:\\repo', '/home/test/worktree', ['deps'], {
        readBundle: async () => '// bundled materializer',
        run
      })
    ).resolves.toBeUndefined()
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ distro: 'Ubuntu', loginPath: 'preferred', timeoutMs: 300_000 })
    )
    const script = run.mock.calls[0][0].script as string
    const encoded = script.match(/ORCA_WORKTREE_REQUEST = '([^']+)'/)![1]
    expect(JSON.parse(Buffer.from(encoded, 'base64').toString())).toEqual({
      source: '/mnt/c/repo',
      target: '/home/test/worktree',
      linkedPaths: ['deps']
    })
  })

  it.each([
    { ...result, timedOut: true },
    { ...result, code: 1 },
    { ...result, stdout: 'unexpected banner' },
    { ...result, stdout: '{"supported":false}' },
    { ...result, stdout: '{"supported":true,"warning":7}' }
  ])('stops creation on uncertain or malformed completion: %j', async (response) => {
    const run = vi.fn().mockResolvedValue(response)
    await expect(
      materializeWslWorktreePaths('Ubuntu', '/source', '/target', [], {
        readBundle: async () => '',
        run
      })
    ).rejects.toThrow('unverifiable')
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('does not dispatch when the packaged bundle is missing', async () => {
    const run = vi.fn()
    await expect(
      materializeWslWorktreePaths('Ubuntu', '/source', '/target', [], {
        readBundle: async () => {
          throw new Error('bundle missing')
        },
        run
      })
    ).rejects.toThrow('bundle missing')
    expect(run).not.toHaveBeenCalled()
  })

  it.skipIf(process.platform === 'win32')(
    'preserves shell metacharacters and long requests over stdin',
    async () => {
      const request = {
        source: "/tmp/$HOME/`nope`/'quote",
        target: '/tmp/target\nnext',
        linkedPaths: Array.from({ length: 1000 }, () => 'long'.repeat(100))
      }
      const script = buildWslWorktreeMaterializationScript(
        "process.stdout.write(Buffer.from(process.env.ORCA_WORKTREE_REQUEST, 'base64').toString())",
        request
      )
      const response = await runProcess({
        program: '/bin/sh',
        args: ['-s'],
        input: script,
        timeoutMs: 5000,
        maxOutputBytes: 1024 * 1024
      })
      expect(response.code).toBe(0)
      expect(JSON.parse(response.stdout)).toEqual(request)
    }
  )
  it.each([false, true])('routes guest link inspection/removal (remove=%s)', async (remove) => {
    const run = vi
      .fn()
      .mockResolvedValue({ ...result, stdout: '{"supported":true,"paths":["deps"]}' })
    expect(
      await inspectWslWorktreeSharedLinks('Ubuntu', '/source', '/target', ['deps'], remove, {
        readBundle: async () => '',
        run
      })
    ).toEqual(['deps'])
    const script = run.mock.calls[0][0].script as string
    const encoded = script.match(/ORCA_WORKTREE_REQUEST = '([^']+)'/)![1]
    expect(JSON.parse(Buffer.from(encoded, 'base64').toString()).operation).toBe(
      remove ? 'remove-links' : 'inspect-links'
    )
  })
  it('does not accept a legacy or malformed response as empty guest links', async () => {
    for (const stdout of ['{"supported":true}', '{"supported":true,"paths":[7]}']) {
      await expect(
        inspectWslWorktreeSharedLinks('Ubuntu', '/source', '/target', [], false, {
          readBundle: async () => '',
          run: vi.fn().mockResolvedValue({ ...result, stdout })
        })
      ).rejects.toThrow('unverifiable')
    }
  })
})

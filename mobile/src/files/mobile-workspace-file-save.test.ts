import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY } from '../../../src/shared/protocol-version'
import type { RpcResponse } from '../transport/types'
import { saveMobileWorkspaceFile } from './mobile-workspace-file-save'
import { MOBILE_CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS } from '../session/mobile-clipboard-image-upload-chunk'

// A workspace host holding `existing` files; writes create exclusively and append like the host's files.writeBase64Chunk.
function workspaceHost(existing: string[]) {
  const files = new Map<string, string>(existing.map((path) => [path, 'old']))
  const calls: { method: string; params: Record<string, unknown> }[] = []
  const reply = (id: string, ok: boolean, result?: unknown): RpcResponse =>
    ok
      ? { id, ok: true, result: result ?? null, _meta: { runtimeId: 'r' } }
      : {
          id,
          ok: false,
          error: { code: 'not_found', message: 'ENOENT' },
          _meta: { runtimeId: 'r' }
        }
  return {
    files,
    calls,
    sendRequest: async (method: string, params?: unknown): Promise<RpcResponse> => {
      const p = z.record(z.string(), z.unknown()).parse(params ?? {})
      calls.push({ method, params: p })
      if (method === 'status.get') {
        return reply('status', true, { capabilities: [FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY] })
      }
      if (method === 'worktree.show') {
        return reply('worktree', true, { worktree: { hostId: 'local' } })
      }
      const path = String(p.relativePath)
      if (method === 'files.stat') {
        return reply('stat', files.has(path), { size: 1, isDirectory: false, mtime: 0 })
      }
      if (p.append !== true && files.has(path)) {
        return {
          id: 'w',
          ok: false,
          error: { code: 'failed', message: 'EEXIST' },
          _meta: { runtimeId: 'r' }
        }
      }
      files.set(path, (p.append === true ? (files.get(path) ?? '') : '') + String(p.contentBase64))
      return reply('w', true)
    }
  }
}

describe('saveMobileWorkspaceFile', () => {
  it('writes under the first free name, never over an existing file', async () => {
    const host = workspaceHost(['docs/paper.pdf', 'docs/paper (2).pdf'])

    const path = await saveMobileWorkspaceFile(host, {
      worktreeId: 'wt-1',
      directory: 'docs',
      name: 'paper.pdf',
      base64: 'JVBERg=='
    })

    expect(path).toBe('docs/paper (3).pdf')
    expect(host.files.get('docs/paper.pdf')).toBe('old')
    expect(host.files.get('docs/paper (3).pdf')).toBe('JVBERg==')
    expect(host.calls.at(-1)?.params).toMatchObject({
      worktree: 'id:wt-1',
      append: false,
      expectedExecutionHostId: 'local'
    })
  })

  it('sends a large file in decodable chunks that append in order', async () => {
    const host = workspaceHost([])
    const base64 = 'QUJD'.repeat(MOBILE_CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS / 2)

    await saveMobileWorkspaceFile(host, {
      worktreeId: 'wt-1',
      directory: 'docs',
      name: 'big.bin',
      base64
    })

    const writes = host.calls.filter((call) => call.method === 'files.writeBase64Chunk')
    expect(writes.map((call) => call.params.append)).toEqual([false, true])
    expect(writes.every((call) => String(call.params.contentBase64).length % 4 === 0)).toBe(true)
    expect(host.files.get('docs/big.bin')).toBe(base64)
  })

  it('keeps a hostile name inside the folder', async () => {
    const host = workspaceHost([])
    await expect(
      saveMobileWorkspaceFile(host, {
        worktreeId: 'wt-1',
        directory: 'docs',
        name: '..',
        base64: ''
      })
    ).resolves.toBe('docs/shared-file')
    await expect(
      saveMobileWorkspaceFile(host, {
        worktreeId: 'wt-1',
        directory: 'docs',
        name: '../../.ssh/key',
        base64: ''
      })
    ).resolves.toBe('docs/.._.._.ssh_key')
  })
})

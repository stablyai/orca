import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { createRelayAiVaultFilesystemProvider } from './ai-vault-service-filesystem'
import { readRelayTranscriptBytes } from './ai-vault-transcript-stream'
import { scanRemoteAiVaultSessions } from '../main/ai-vault/remote-session-scanner'
import { getRemoteHostPlatform } from '../main/ssh/ssh-remote-platform'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function collect(bytes: AsyncIterable<Buffer>) {
  const chunks: Buffer[] = []
  for await (const chunk of bytes) {
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}
async function scan(root: string) {
  const provider = createRelayAiVaultFilesystemProvider({ homeDirectory: root, environment: {} })
  try {
    return await scanRemoteAiVaultSessions({
      provider,
      executionHostId: 'ssh:production-reader-proof',
      remoteHome: root,
      hostPlatform: getRemoteHostPlatform(
        process.platform === 'win32'
          ? 'win32-x64'
          : process.platform === 'darwin'
            ? 'darwin-arm64'
            : 'linux-x64'
      ),
      dshSessionsDir: join(root, 'sessions')
    })
  } finally {
    provider.dispose()
  }
}

describe('production relay DSH byte reads', () => {
  it('passes actual persisted schema through the production provider and scanner without text binary rejection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-relay-dsh-'))
    roots.push(root)
    const path = join(
      root,
      'sessions',
      'project',
      'session-dsh-history-proof',
      'session.v4.jsonl.zstd'
    )
    await mkdir(dirname(path), { recursive: true })
    const original = await readFile(
      new URL('../main/ai-vault/__fixtures__/dsh-v4-auth-rejected.jsonl', import.meta.url),
      'utf8'
    )
    const compressed = Buffer.concat(
      original
        .trim()
        .split('\n')
        .map((row) => zstdCompressSync(Buffer.from(`${row}\n`)))
    )
    expect(compressed.includes(0)).toBe(true)
    await writeFile(path, compressed)
    await expect(collect(readRelayTranscriptBytes(path))).rejects.toThrow(/binary/i)
    expect(await collect(readRelayTranscriptBytes(path, undefined, 'dsh-zstd'))).toEqual(compressed)
    const result = await scan(root)
    expect(result.issues.filter((issue) => issue.agent === 'dsh')).toEqual([])
    expect(result.sessions.find((session) => session.agent === 'dsh')).toMatchObject({
      sessionId: 'session-dsh-history-proof',
      messageCount: 1,
      model: 'deepseek-flash',
      previewMessages: [
        expect.objectContaining({
          role: 'user',
          text: 'DSH history proof: inspect this folder without generating an answer.'
        })
      ]
    })
    const unrelated = join(root, 'unrelated.jsonl')
    await writeFile(unrelated, compressed)
    await expect(collect(readRelayTranscriptBytes(unrelated))).rejects.toThrow(/binary/i)
    await expect(
      collect(readRelayTranscriptBytes(unrelated, undefined, 'dsh-zstd'))
    ).rejects.toThrow('canonical')
    await writeFile(path, Buffer.from([0, 1, 2, 3, 4]))
    await expect(collect(readRelayTranscriptBytes(path, undefined, 'dsh-zstd'))).rejects.toThrow(
      'canonical'
    )
  })

  it.skipIf(!process.env.ORCA_REAL_DSH_HISTORY_FILE)(
    'reads untouched official compressed capture through the production relay scanner',
    async () => {
      const path = process.env.ORCA_REAL_DSH_HISTORY_FILE
      if (!path) {
        throw new Error('Set ORCA_REAL_DSH_HISTORY_FILE')
      }
      const result = await scan(resolve(dirname(path), '../../..'))
      expect(result.issues.filter((issue) => issue.agent === 'dsh')).toEqual([])
      expect(result.sessions.find((session) => session.agent === 'dsh')).toMatchObject({
        messageCount: 1,
        model: 'deepseek-flash',
        filePath: path,
        previewMessages: [
          expect.objectContaining({
            role: 'user',
            text: 'DSH history proof: inspect this folder without generating an answer.'
          })
        ]
      })
    }
  )
})

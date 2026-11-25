import { spawn } from 'node:child_process'
import { linkSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { listCodexTranscriptHolders } from './codex-transcript-writer-check'

const TRANSCRIPT = '/home/u/.codex/sessions/2026/11/01/rollout-thread.jsonl'
type TranscriptWriterCheckDeps = NonNullable<Parameters<typeof listCodexTranscriptHolders>[1]>

function deps(overrides: Partial<TranscriptWriterCheckDeps>): TranscriptWriterCheckDeps {
  return {
    platform: 'darwin',
    exec: async () => ({ code: 1, stdout: '', stderr: '' }),
    findProcHolders: async () => [],
    ...overrides
  }
}

describe('Codex transcript holders', () => {
  it('distinguishes a failed lsof from an empty result even when both exit with code 1', async () => {
    await expect(listCodexTranscriptHolders(TRANSCRIPT, deps({}))).resolves.toEqual([])
    const failed = deps({ exec: async () => ({ code: 1, stdout: '', stderr: 'status error' }) })
    await expect(listCodexTranscriptHolders(TRANSCRIPT, failed)).resolves.toBeNull()
  })

  it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
    'sees a real process that still holds the transcript open, and its exit',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'orca-writer-check-'))
      const transcript = join(dir, 'rollout.jsonl')
      const alias = join(dir, 'rollout-alias.jsonl')
      writeFileSync(transcript, '{}\n')
      linkSync(transcript, alias)
      // The recorder's open descriptor can name another link to the same rollout inode.
      const holder = spawn('sh', ['-c', 'exec 3>>"$1"; echo open; exec sleep 30', 'sh', alias])
      try {
        await new Promise<void>((resolve) => holder.stdout.once('data', () => resolve()))
        await vi.waitFor(
          async () => expect(await listCodexTranscriptHolders(transcript)).toEqual([holder.pid]),
          // Why a real-time bound: lsof and /proc read the live process table.
          { timeout: 10_000 }
        )
        holder.kill('SIGKILL')
        await new Promise<void>((resolve) => holder.once('exit', () => resolve()))
        await vi.waitFor(
          async () => expect(await listCodexTranscriptHolders(transcript)).toEqual([]),
          { timeout: 10_000 }
        )
      } finally {
        holder.kill('SIGKILL')
        rmSync(dir, { recursive: true, force: true })
      }
    },
    // Why: two lsof runs on a loaded machine.
    30_000
  )
})

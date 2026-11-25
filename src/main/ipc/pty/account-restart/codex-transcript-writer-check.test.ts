import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  transcriptHasNoOpenWriter,
  type TranscriptWriterCheckDeps
} from './codex-transcript-writer-check'

const TRANSCRIPT = '/home/u/.codex/sessions/2026/11/01/rollout-thread.jsonl'

function deps(overrides: Partial<TranscriptWriterCheckDeps>): TranscriptWriterCheckDeps {
  return {
    platform: 'darwin',
    exec: async () => ({ code: 1, stdout: '', stderr: '' }),
    openPaths: async () => new Set(),
    realpath: async (path) => path,
    ...overrides
  }
}

describe('the stopped transcript has no open writer', () => {
  it('on macOS, only lsof finding no process is proof', async () => {
    await expect(transcriptHasNoOpenWriter(TRANSCRIPT, deps({}))).resolves.toBe(true)
    const holder = deps({ exec: async () => ({ code: 0, stdout: '4242\n', stderr: '' }) })
    await expect(transcriptHasNoOpenWriter(TRANSCRIPT, holder)).resolves.toBe(false)
    // A missing file or a failed lsof also exits 1, but says why: not proof.
    const failed = deps({ exec: async () => ({ code: 1, stdout: '', stderr: 'status error' }) })
    await expect(transcriptHasNoOpenWriter(TRANSCRIPT, failed)).resolves.toBe(false)
    const timedOut = deps({ exec: async () => ({ code: null, stdout: '', stderr: '' }) })
    await expect(transcriptHasNoOpenWriter(TRANSCRIPT, timedOut)).resolves.toBe(false)
  })

  it('on Linux, compares the real path with every open descriptor', async () => {
    const linked = deps({
      platform: 'linux',
      realpath: async () => '/shared/sessions/rollout-thread.jsonl',
      openPaths: async () => new Set(['/shared/sessions/rollout-thread.jsonl'])
    })
    // Held through a linked sessions folder: still the same file.
    await expect(transcriptHasNoOpenWriter(TRANSCRIPT, linked)).resolves.toBe(false)
    const clear = deps({ platform: 'linux', openPaths: async () => new Set(['/tmp/other']) })
    await expect(transcriptHasNoOpenWriter(TRANSCRIPT, clear)).resolves.toBe(true)
    const unreadable = deps({ platform: 'linux', openPaths: async () => null })
    await expect(transcriptHasNoOpenWriter(TRANSCRIPT, unreadable)).resolves.toBe(false)
  })

  it('on Windows, leaves the proof to the owned job tree ending', async () => {
    const exec = vi.fn()
    await expect(
      transcriptHasNoOpenWriter(TRANSCRIPT, deps({ platform: 'win32', exec }))
    ).resolves.toBe(true)
    expect(exec).not.toHaveBeenCalled()
  })

  it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
    'sees a real process that still holds the transcript open, and its exit',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'orca-writer-check-'))
      const transcript = join(dir, 'rollout.jsonl')
      writeFileSync(transcript, '{}\n')
      // Opens the file for append and keeps it, as Codex's rollout recorder does.
      const holder = spawn('sh', ['-c', 'exec 3>>"$1"; echo open; exec sleep 30', 'sh', transcript])
      try {
        await new Promise<void>((resolve) => holder.stdout.once('data', () => resolve()))
        await vi.waitFor(
          async () => expect(await transcriptHasNoOpenWriter(transcript)).toBe(false),
          // Why a real-time bound: lsof and /proc read the live process table.
          { timeout: 10_000 }
        )
        holder.kill('SIGKILL')
        await new Promise<void>((resolve) => holder.once('exit', () => resolve()))
        await vi.waitFor(
          async () => expect(await transcriptHasNoOpenWriter(transcript)).toBe(true),
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

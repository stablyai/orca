import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  codexTuiStatusProbeInput,
  parseCodexTuiStatusSessionId,
  proveCodexTuiRollout,
  resolveLiveCodexTuiRollout,
  resolvePinnedCodexRolloutProof
} from './codex-tui-rollout-proof'

const THREAD = '019fd900-77aa-7c19-8bd0-2b3c4d5e6f70'
const OTHER_THREAD = '019fd900-77aa-7c19-8bd0-2b3c4d5e6f71'

describe('Codex TUI rollout proof', () => {
  it('parses the exact session shown by status', () => {
    expect(parseCodexTuiStatusSessionId(`│ Session: ${THREAD} │`)).toBe(THREAD)
    expect(parseCodexTuiStatusSessionId(`Session ID: ${THREAD}`)).toBe(THREAD)
    expect(parseCodexTuiStatusSessionId(`Session: \u001b[22m${THREAD}\u001b[2m`)).toBe(THREAD)
    expect(parseCodexTuiStatusSessionId('Session: not-a-session')).toBeNull()
  })

  it('parses the Codex 0.148 status screen and semantic thread labels', () => {
    const status = [
      '\u001b[2m│  >_ OpenAI Codex (v0.148.0)                                                  │',
      '│  Model:                       gpt-5.6-sol (reasoning high, summaries auto)   │',
      `│  Session:                     \u001b[22m${THREAD}\u001b[2m           │`
    ].join('\n')

    expect(parseCodexTuiStatusSessionId(status)).toBe(THREAD)
    expect(parseCodexTuiStatusSessionId(`Thread ID: ${OTHER_THREAD}`)).toBe(OTHER_THREAD)
  })

  it('uses Kitty Enter only while the TUI negotiated Kitty input', () => {
    expect(codexTuiStatusProbeInput(0)).toEqual({
      command: '\u001b[200~/status\u001b[201~',
      submit: '\r'
    })
    expect(codexTuiStatusProbeInput(1).submit).toBe('\u001b[13u')
    expect(codexTuiStatusProbeInput(31).submit).toBe('\u001b[13u')
  })

  it('resolves only the exact session_meta rollout under the pinned account home', async () => {
    const files = async function* (): AsyncGenerator<string> {
      yield '/pinned/sessions/scratch/rollout-wrong.jsonl'
      yield `/other/sessions/2026/08/11/rollout-now-${THREAD}.jsonl`
      yield `/pinned/sessions/2026/08/11/rollout-now-${THREAD}.jsonl`
    }
    const readSessionMetaId = vi.fn(async () => THREAD)

    await expect(
      resolvePinnedCodexRolloutProof('/pinned', THREAD, { listFiles: files, readSessionMetaId })
    ).resolves.toBe(`/pinned/sessions/2026/08/11/rollout-now-${THREAD}.jsonl`)
    expect(readSessionMetaId).toHaveBeenCalledTimes(1)
  })

  it('accepts Codex rollout ids with a distinct rollout suffix', async () => {
    const files = async function* (): AsyncGenerator<string> {
      yield `/pinned/sessions/2026/08/11/rollout-now-${THREAD}_019fd900-77aa-7c19-8bd0-2b3c4d5e6f71.jsonl`
    }
    const readSessionMetaId = vi.fn(async () => THREAD)

    await expect(
      resolvePinnedCodexRolloutProof('/pinned', THREAD, { listFiles: files, readSessionMetaId })
    ).resolves.toContain(`rollout-now-${THREAD}_`)
  })

  it('skips a rollout file that vanishes mid-scan instead of aborting the proof', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-rollout-proof-'))
    try {
      const day = join(root, 'sessions', '2026', '08', '11')
      await mkdir(day, { recursive: true })
      const real = join(day, `rollout-now-${THREAD}.jsonl`)
      await writeFile(
        real,
        `${JSON.stringify({ type: 'session_meta', payload: { id: THREAD } })}\n`
      )
      // Listed but already deleted by the time the scan reads it — Codex prunes
      // and rewrites rollout files while the scan runs.
      const vanished = join(day, `rollout-gone-${THREAD}.jsonl`)
      const files = async function* (): AsyncGenerator<string> {
        yield vanished
        yield real
      }

      await expect(
        resolvePinnedCodexRolloutProof(root, THREAD, { listFiles: files })
      ).resolves.toBe(real)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a rollout whose session_meta names another thread', async () => {
    const files = async function* (): AsyncGenerator<string> {
      yield `/pinned/sessions/2026/08/11/rollout-now-${THREAD}.jsonl`
    }
    await expect(
      resolvePinnedCodexRolloutProof('/pinned', THREAD, {
        listFiles: files,
        readSessionMetaId: async () => OTHER_THREAD
      })
    ).resolves.toBeNull()
  })

  it('rejects a different status session after filesystem proof', async () => {
    let reads = 0
    const write = vi.fn((_data: string) => true)
    await expect(
      proveCodexTuiRollout({
        codexHome: '/pinned',
        threadId: THREAD,
        kittyKeyboardFlags: 0,
        readOutput: () => ({
          text: `Session: ${OTHER_THREAD}`,
          lastOutputAt: reads++ > 0 ? 2 : 1
        }),
        write,
        resolveRollout: async () => '/pinned/sessions/rollout.jsonl',
        delay: async () => undefined
      })
    ).rejects.toThrow('resumed a different Codex session')
    expect(write).toHaveBeenCalledTimes(2)
  })

  it('dismisses status only after the exact session is observed', async () => {
    let reads = 0
    const write = vi.fn((_data: string) => true)
    await expect(
      proveCodexTuiRollout({
        codexHome: '/pinned',
        threadId: THREAD,
        kittyKeyboardFlags: 1,
        readOutput: () => ({
          text: reads++ > 0 ? `Session: ${THREAD}` : '',
          lastOutputAt: reads > 1 ? 2 : 1
        }),
        write,
        resolveRollout: async () => '/pinned/sessions/rollout.jsonl',
        delay: async () => undefined
      })
    ).resolves.toEqual({ transcriptPath: '/pinned/sessions/rollout.jsonl' })
    expect(write.mock.calls.map(([data]) => data)).toEqual([
      '\u001b[200~/status\u001b[201~',
      '\u001b[13u',
      '\u001b'
    ])
  })

  it('discovers the live thread and resolves its pinned rollout', async () => {
    let reads = 0
    const write = vi.fn((_data: string) => true)
    const resolveRollout = vi.fn(async () => '/pinned/sessions/rollout.jsonl')

    await expect(
      resolveLiveCodexTuiRollout({
        codexHome: '/pinned',
        kittyKeyboardFlags: 0,
        readOutput: () => ({
          text: reads++ > 0 ? `Session: ${THREAD}` : '',
          lastOutputAt: reads > 1 ? 2 : 1
        }),
        write,
        resolveRollout,
        delay: async () => undefined
      })
    ).resolves.toEqual({ threadId: THREAD, transcriptPath: '/pinned/sessions/rollout.jsonl' })
    expect(resolveRollout).toHaveBeenCalledWith('/pinned', THREAD)
    expect(write.mock.calls.map(([data]) => data)).toEqual([
      '\u001b[200~/status\u001b[201~',
      '\r',
      '\u001b'
    ])
  })

  it('accepts a proven blank Codex 0.148 session before its lazy rollout exists', async () => {
    let reads = 0
    const write = vi.fn((_data: string) => true)
    const resolveRollout = vi.fn(async () => null)

    await expect(
      resolveLiveCodexTuiRollout({
        codexHome: '/pinned',
        kittyKeyboardFlags: 1,
        readOutput: () => ({
          text:
            reads++ > 0
              ? `│  >_ OpenAI Codex (v0.148.0) │\n│  Session: \u001b[22m${THREAD}\u001b[2m │`
              : '',
          lastOutputAt: reads > 1 ? 2 : 1
        }),
        write,
        resolveRollout,
        delay: async () => undefined
      })
    ).resolves.toEqual({ threadId: THREAD })
    expect(resolveRollout).toHaveBeenCalledTimes(5)
    expect(write.mock.calls.map(([data]) => data)).toEqual([
      '\u001b[200~/status\u001b[201~',
      '\u001b[13u',
      '\u001b'
    ])
  })
})

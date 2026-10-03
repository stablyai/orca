import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveSessionFilePath } from './session-file-resolver'
import { readNativeChatTranscript } from './transcript-reader'
import {
  nativeChatLineDecoderForAgent,
  readNativeChatTranscriptTailFile
} from './transcript-tail-reader'
import { nativeChatTurnLifecycleDecoderForAgent } from './transcript-turn-lifecycle'

let root: string | undefined

afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
  root = undefined
})

async function fixture() {
  root = await mkdtemp(join(tmpdir(), 'orca-agy-chat-'))
  const dir = join(root, 'conversation', '.system_generated', 'logs')
  await mkdir(dir, { recursive: true })
  const path = join(dir, 'transcript.jsonl')
  await copyFile(new URL('./__fixtures__/antigravity/tool-turn.jsonl', import.meta.url), path)
  return { path, options: { antigravityBrainDir: root } }
}

describe('Antigravity native transcript reading', () => {
  it('resolves its CLI conversation and preserves full-reader / tail-reader parity', async () => {
    const { path, options } = await fixture()
    expect(await resolveSessionFilePath('antigravity', 'conversation', options)).toBe(path)
    const full = await readNativeChatTranscript('antigravity', 'conversation', options)
    const decode = nativeChatLineDecoderForAgent('antigravity')
    expect(decode).not.toBeNull()
    if (!decode || !('messages' in full)) {
      throw new Error('transcript reader unavailable')
    }
    const tail = await readNativeChatTranscriptTailFile(path, 20, decode)
    expect(tail.messages).toEqual(full.messages)
    expect(full.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant'
    ])
    expect(nativeChatTurnLifecycleDecoderForAgent('antigravity')).toBeNull()
    expect(full.lifecycle).toBeUndefined()
    expect(tail.lifecycle).toBeUndefined()
  })

  it('rejects path-shaped ids and does not substitute a native file for a WSL session', async () => {
    const { options } = await fixture()
    for (const id of ['../conversation', '..\\conversation', '/conversation', 'C:conversation']) {
      expect(await resolveSessionFilePath('antigravity', id, options)).toBeNull()
    }
    expect(
      await resolveSessionFilePath('antigravity', 'conversation', {
        ...options,
        wslDistro: 'Ubuntu'
      })
    ).toBeNull()
    expect(await resolveSessionFilePath('antigravity', 'missing', options)).toBeNull()
  })
})

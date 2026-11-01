import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { foldToolMessages } from '../../shared/native-chat/tools/native-chat-tool-fold'
import { projectStructuredItemToNativeChat } from '../../shared/structured-agent-session-projection'
import {
  claudeToolBody,
  claudeToolResults,
  readClaudeMessageEnvelope
} from '../claude/claude-structured-item-translation'
import { decodeClaudeTranscriptLine } from './transcript-line-decoders-claude'
import { readNativeChatTranscript } from './transcript-reader'
import { attachResolvedToolImages, resolveToolResultImageRefs } from './tool-result-images'

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function claudeLine(record: unknown): string {
  return JSON.stringify(record)
}

describe('Claude Read image tool results', () => {
  let directory: string | undefined

  afterEach(() => {
    if (directory) {
      rmSync(directory, { recursive: true, force: true })
      directory = undefined
    }
  })

  it('renders the Read file as an image-ref on the assistant row', async () => {
    directory = mkdtempSync(join(tmpdir(), 'orca-chat-image-'))
    const shot = join(directory, 'shot.png')
    writeFileSync(shot, Buffer.from(PNG, 'base64'))
    const spool = vi.fn(() => '/should-not-spool.png')
    const assistant = claudeLine({
      type: 'assistant',
      uuid: 'asst-1',
      timestamp: '2026-10-31T00:00:00.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_read', name: 'Read', input: { file_path: shot } }]
      }
    })
    const toolResult = claudeLine({
      type: 'user',
      uuid: 'user-1',
      timestamp: '2026-10-31T00:00:01.000Z',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_read',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }
            ]
          }
        ]
      }
    })
    const decoded = [assistant, toolResult].flatMap((line, index) => {
      const message = decodeClaudeTranscriptLine(line, `fallback-${index}`)
      return message ? [message] : []
    })
    expect(decoded[1]?.role).toBe('tool')
    const resolved = attachResolvedToolImages(decoded, spool)
    expect(spool).not.toHaveBeenCalled()
    expect(JSON.stringify(resolved)).not.toContain(PNG)
    const folded = foldToolMessages(resolved)
    expect(folded).toHaveLength(1)
    expect(folded[0]?.blocks).toContainEqual({ type: 'image-ref', path: shot, alt: 'shot.png' })

    writeFileSync(join(directory, 'session.jsonl'), `${assistant}\n${toolResult}\n`)
    const transcript = await readNativeChatTranscript('claude', 'sess', {
      filePath: join(directory, 'session.jsonl')
    })
    if ('error' in transcript) {
      throw new Error(transcript.error)
    }
    expect(transcript.messages[1]?.blocks).toContainEqual({
      type: 'image-ref',
      path: shot,
      alt: 'shot.png'
    })
    expect(JSON.stringify(transcript.messages)).not.toContain(PNG)
  })

  it('spools a missing Read file once and leaves an image-only turn unfolded', () => {
    const spool = vi.fn(() => '/attachments/shot.png')
    const assistant = decodeClaudeTranscriptLine(
      claudeLine({
        type: 'assistant',
        uuid: 'asst-1',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_read',
              name: 'Read',
              input: { file_path: '/tmp/missing-shot.png' }
            }
          ]
        }
      }),
      'asst'
    )
    const toolResult = decodeClaudeTranscriptLine(
      claudeLine({
        type: 'user',
        uuid: 'user-1',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_read',
              content: [
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }
              ]
            }
          ]
        }
      }),
      'user'
    )
    expect(assistant && toolResult).toBeTruthy()
    const resolved = attachResolvedToolImages([assistant!, toolResult!], spool)
    expect(spool).toHaveBeenCalledOnce()
    expect(resolved[1]?.blocks).toContainEqual({
      type: 'image-ref',
      path: '/attachments/shot.png',
      alt: 'shot.png'
    })
    expect(JSON.stringify(resolved)).not.toContain(PNG)
    const pasted = {
      id: 'paste',
      role: 'user' as const,
      blocks: [{ type: 'image-ref' as const, path: '/tmp/paste.png' }],
      timestamp: null,
      source: 'transcript' as const
    }
    expect(foldToolMessages([assistant!, pasted])).toEqual([assistant, pasted])
  })

  it('keeps a structured Read image as a path on the tool row', () => {
    directory = mkdtempSync(join(tmpdir(), 'orca-chat-image-'))
    const shot = join(directory, 'shot.png')
    writeFileSync(shot, Buffer.from(PNG, 'base64'))
    const envelope = readClaudeMessageEnvelope({
      type: 'user',
      session_id: 'session',
      uuid: 'user-1',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_read',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }
            ]
          }
        ]
      }
    })
    expect(envelope).not.toBeNull()
    const [result] = claudeToolResults(envelope!)
    const images = resolveToolResultImageRefs({ sources: result?.images ?? [], filePath: shot })
    const body = claudeToolBody({
      tool: { id: 'toolu_read', name: 'Read', input: { file_path: shot } },
      result,
      images
    })
    expect(body).toMatchObject({ images: [{ path: shot, alt: 'shot.png' }] })
    expect(JSON.stringify(body)).not.toContain(PNG)
    const projected = projectStructuredItemToNativeChat({
      itemId: 'tool-1',
      revision: 1,
      sequence: 1,
      observedAt: 1,
      body
    })
    expect(projected?.role).toBe('assistant')
    expect(projected?.blocks).toContainEqual({ type: 'image-ref', path: shot, alt: 'shot.png' })
  })

  it('spools result bytes when the input file contains a different image', () => {
    directory = mkdtempSync(join(tmpdir(), 'orca-chat-image-'))
    const shot = join(directory, 'input.png')
    writeFileSync(shot, 'different image')
    const spool = vi.fn(() => '/attachments/result.png')
    expect(
      resolveToolResultImageRefs({ sources: [{ base64: PNG }], filePath: shot, spool })
    ).toEqual([{ type: 'image-ref', path: '/attachments/result.png', alt: 'result.png' }])
    expect(spool).toHaveBeenCalledOnce()
  })

  it('matches file formats that cannot be spooled', () => {
    directory = mkdtempSync(join(tmpdir(), 'orca-chat-image-'))
    const shot = join(directory, 'input.svg')
    const bytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')
    writeFileSync(shot, bytes)
    expect(
      resolveToolResultImageRefs({
        sources: [{ base64: bytes.toString('base64') }],
        filePath: shot
      })
    ).toEqual([{ type: 'image-ref', path: shot, alt: 'input.svg' }])
  })
})

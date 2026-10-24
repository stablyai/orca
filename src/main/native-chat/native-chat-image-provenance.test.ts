import { describe, expect, it } from 'vitest'
import { codexImageItemBody } from '../codex/codex-image-item-translation'
import { nativeChatTranscriptIncludesPath } from './native-chat-file-provenance'
import type { RuntimeMobileSessionClientTab } from '../../shared/runtime-types'

const path = '/mnt/data/chart.png'
const tab: RuntimeMobileSessionClientTab = {
  type: 'agent-session',
  id: 'agent-session:session-1',
  sessionId: 'session-1',
  title: 'Codex',
  agent: 'codex',
  isActive: false
}

describe('Codex process image provenance', () => {
  it.each(['#variant', '?variant', ':12'])(
    'keeps a tool image path literal, including %s',
    async (suffix) => {
      const fullPath = `${path}${suffix}`
      const args = {
        tabs: [tab],
        context: { tabId: tab.id, sessionId: 'session-1' },
        pathText: fullPath,
        absolutePath: fullPath,
        readStructuredMessages: async () => [
          codexImageItemBody({ id: 'view', type: 'imageView', path: fullPath })
        ]
      }
      await expect(nativeChatTranscriptIncludesPath(args)).resolves.toBe(true)
      await expect(
        nativeChatTranscriptIncludesPath({ ...args, pathText: path, absolutePath: path })
      ).resolves.toBe(false)
    }
  )
  it.each([
    { id: 'view-1', type: 'imageView', path },
    { id: 'generate-1', type: 'imageGeneration', status: 'completed', savedPath: path }
  ])('recognizes the actual $type journal message without a final Markdown link', async (item) => {
    const body = codexImageItemBody(item)
    const args = {
      tabs: [tab],
      context: { tabId: 'agent-session:session-1', sessionId: 'session-1' },
      pathText: path,
      absolutePath: path,
      readStructuredMessages: async () => [body]
    }
    await expect(nativeChatTranscriptIncludesPath(args)).resolves.toBe(true)
    await expect(
      nativeChatTranscriptIncludesPath({
        ...args,
        absolutePath: `${path}.backup`,
        pathText: `${path}.backup`
      })
    ).resolves.toBe(false)
    await expect(
      nativeChatTranscriptIncludesPath({
        ...args,
        context: { ...args.context, sessionId: 'other' }
      })
    ).resolves.toBe(false)
    await expect(
      nativeChatTranscriptIncludesPath({
        ...args,
        readStructuredMessages: async () => [{ ...body, role: 'user' as const }]
      })
    ).resolves.toBe(false)
  })
})

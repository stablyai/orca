import { describe, expect, it, vi } from 'vitest'
import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import { webHostSessionNativeChatOperations } from './web-host-session-native-chat-operations'
import type { HostSessionNativeChatTarget } from './host-session-native-chat-operations'

const target: HostSessionNativeChatTarget = {
  workspaceId: 'workspace',
  sessionId: 'session',
  agent: 'codex',
  terminalId: 'tab',
  transcriptPath: null,
  clientId: null
}
describe('hosted chat file consumers', () => {
  it('supplies the stable tab for generic search/open binding and keeps device attachments on their existing capability', async () => {
    const fileSearch = vi.fn().mockResolvedValue({ paths: ['src/main.ts'] })
    const openFile = vi.fn().mockResolvedValue(null)
    const attachImage = vi.fn().mockResolvedValue({ status: 'cancelled' })
    const operations = webHostSessionNativeChatOperations({
      nativeChat: { fileSearch, openFile, attachImage }
    } as unknown as MobileWebBridgeClient)
    expect(await operations.searchFiles(target, 'src')).toEqual(['src/main.ts'])
    await operations.openFile(target, 'src/main.ts')
    expect(fileSearch).toHaveBeenCalledWith(
      { workspaceId: 'workspace', sessionId: 'session', query: 'src' },
      'tab'
    )
    expect(openFile).toHaveBeenCalledWith(
      { workspaceId: 'workspace', sessionId: 'session', pathText: 'src/main.ts' },
      'tab'
    )
    expect(await operations.attachImage!(target, 'library')).toEqual({ status: 'cancelled' })
    expect(attachImage).toHaveBeenCalledWith({
      workspaceId: 'workspace',
      sessionId: 'session',
      source: 'library'
    })
  })
  it('keeps file links best effort without retrying an ambiguous open', async () => {
    const openFile = vi.fn().mockRejectedValue(new Error('lost acknowledgement'))
    const operations = webHostSessionNativeChatOperations({
      nativeChat: { openFile }
    } as unknown as MobileWebBridgeClient)
    await expect(operations.openFile(target, 'src/main.ts')).resolves.toBeUndefined()
    expect(openFile).toHaveBeenCalledOnce()
  })
})

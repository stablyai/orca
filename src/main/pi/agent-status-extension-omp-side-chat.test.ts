import { describe, expect, it, vi } from 'vitest'
import {
  OMP_SIDE_CHAT_DIR_ENV,
  OMP_SIDE_CHAT_DIR_NAME
} from '../../shared/agent-launch/side-chat/omp-side-chat-session'
import { SIDE_CHAT_CONTEXT } from '../../shared/agent-launch/side-chat/side-chat'
import { createAgentStatusExtensionHarness } from './agent-status-extension-test-harness'

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve()
  }
}

const dir = `/sessions/project/${OMP_SIDE_CHAT_DIR_NAME}/side-1`
const file = `${dir}/session.jsonl`

function sideChatContext(file: string, parentSession?: string) {
  return {
    sessionManager: {
      getSessionId: () => 'side',
      getSessionFile: () => file,
      getHeader: () => ({ parentSession })
    }
  }
}

describe('OMP side chat through the status extension', () => {
  it('injects one hidden boundary, clears the env, and deletes the folder on shutdown', async () => {
    const h = createAgentStatusExtensionHarness({
      kind: 'omp',
      env: { [OMP_SIDE_CHAT_DIR_ENV]: dir }
    })
    await h.callHook('session_start', {}, sideChatContext(file))
    expect(h.sendMessageMock).toHaveBeenCalledExactlyOnceWith({
      customType: 'orca-side-chat-boundary',
      content: SIDE_CHAT_CONTEXT,
      display: false
    })
    expect(h.processEnv[OMP_SIDE_CHAT_DIR_ENV]).toBeUndefined()
    await h.callHook('session_start', {}, sideChatContext(file))
    expect(h.sendMessageMock).toHaveBeenCalledTimes(1)
    expect(h.fsMock.rmSync).not.toHaveBeenCalled()
    await h.callHook('session_shutdown', {})
    expect(h.fsMock.rmSync).toHaveBeenCalledExactlyOnceWith(dir, { recursive: true, force: true })
  })

  it('does nothing without the env var', async () => {
    const h = createAgentStatusExtensionHarness({ kind: 'omp' })
    await h.callHook('session_start', {}, sideChatContext(file))
    await h.callHook('session_shutdown', {})
    expect(h.sendMessageMock).not.toHaveBeenCalled()
    expect(h.fsMock.rmSync).not.toHaveBeenCalled()
  })

  it.each([
    ['outside the folder', '/sessions/project/other.jsonl'],
    ['in a sibling sharing the prefix', `${dir}-2/session.jsonl`]
  ])('ignores a session file %s', async (_label, otherFile) => {
    const h = createAgentStatusExtensionHarness({
      kind: 'omp',
      env: { [OMP_SIDE_CHAT_DIR_ENV]: dir }
    })
    await h.callHook('session_start', {}, sideChatContext(otherFile))
    expect(h.processEnv[OMP_SIDE_CHAT_DIR_ENV]).toBeUndefined()
    await h.callHook('session_shutdown', {})
    expect(h.sendMessageMock).not.toHaveBeenCalled()
    expect(h.fsMock.rmSync).not.toHaveBeenCalled()
  })

  it('accepts Windows separators', async () => {
    const windowsDir = 'C:\\repo\\sessions\\.orca-side-chats\\side-1'
    const h = createAgentStatusExtensionHarness({
      kind: 'omp',
      env: { [OMP_SIDE_CHAT_DIR_ENV]: windowsDir }
    })
    await h.callHook('session_start', {}, sideChatContext(`${windowsDir}\\session.jsonl`))
    expect(h.sendMessageMock).toHaveBeenCalledTimes(1)
  })

  it('keeps status and prefill for a forked side chat but not for other forked children', async () => {
    const side = createAgentStatusExtensionHarness({
      kind: 'omp',
      env: { ORCA_OMP_PREFILL: 'Side draft' }
    })
    const setEditorText = vi.fn()
    const sideCtx = { ...sideChatContext(file, 'parent-id'), ui: { setEditorText } }
    await side.callHook('session_start', {}, sideCtx)
    await side.callHook('agent_start', {}, sideCtx)
    await settle()
    expect(setEditorText).toHaveBeenCalledExactlyOnceWith('Side draft')
    expect(side.processEnv.ORCA_OMP_PREFILL).toBeUndefined()
    expect(side.fetchMock).toHaveBeenCalled()

    const child = createAgentStatusExtensionHarness({
      kind: 'omp',
      env: { ORCA_OMP_PREFILL: 'Child draft' }
    })
    const childEditor = vi.fn()
    const childCtx = {
      ...sideChatContext('/sessions/child.jsonl', 'parent-id'),
      ui: { setEditorText: childEditor }
    }
    await child.callHook('session_start', {}, childCtx)
    await child.callHook('agent_start', {}, childCtx)
    await settle()
    expect(childEditor).not.toHaveBeenCalled()
    expect(child.processEnv.ORCA_OMP_PREFILL).toBe('Child draft')
    expect(child.fetchMock).not.toHaveBeenCalled()
  })
})

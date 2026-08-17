import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installClaudePermissionDenyTranscriptWatch } from './claude-permission-deny-transcript-watch'

const PANE_KEY = 'tab-deny:33333333-3333-4333-8333-333333333333'
const TOOL_USE_ID = 'toolu_01SR4NdZW4V8MHVEXA5C2VDH'

// Real Claude transcript entry shape for a denied tool (captured from a live deny).
function denyLine(toolUseId = TOOL_USE_ID): string {
  return `${JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          content: "The user doesn't want to proceed with this tool use.",
          is_error: true,
          tool_use_id: toolUseId
        }
      ]
    }
  })}\n`
}

function successLine(toolUseId = TOOL_USE_ID): string {
  return `${JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', content: 'ok', tool_use_id: toolUseId }]
    }
  })}\n`
}

type Listener = (event: {
  paneKey: string
  connectionId: string | null
  receivedAt: number
  stateStartedAt: number
  toolUseId?: string
  providerSession?: { transcriptPath?: string }
  providerSessionOnly?: boolean
  payload: { state: string; agentType?: 'claude' | 'codex'; toolName?: string; prompt: string }
}) => void

function createServerFacade(): {
  server: Parameters<typeof installClaudePermissionDenyTranscriptWatch>[0]
  emit: Listener
  infer: ReturnType<typeof vi.fn>
} {
  let listener: Listener | null = null
  const infer = vi.fn().mockReturnValue(true)
  return {
    server: {
      subscribeEnrichedStatus: (l) => {
        listener = l as Listener
        return () => {
          listener = null
        }
      },
      inferClaudePermissionDenied: infer
    },
    emit: (event) => listener?.(event),
    infer
  }
}

function waitEvent(
  transcriptPath: string,
  overrides: Partial<Parameters<Listener>[0]> = {}
): Parameters<Listener>[0] {
  return {
    paneKey: PANE_KEY,
    connectionId: null,
    receivedAt: Date.now(),
    stateStartedAt: Date.now() - 50,
    toolUseId: TOOL_USE_ID,
    providerSession: { transcriptPath },
    payload: { state: 'waiting', agentType: 'claude', toolName: 'Write', prompt: 'make probe' },
    ...overrides
  }
}

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('claude permission deny transcript watch', () => {
  let dir = ''
  let transcriptPath = ''
  let dispose: (() => void) | null = null

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'deny-watch-'))
    transcriptPath = join(dir, 'session.jsonl')
    await writeFile(transcriptPath, '{"type":"assistant"}\n')
  })

  afterEach(async () => {
    dispose?.()
    dispose = null
    await rm(dir, { recursive: true, force: true })
  })

  function install(facade: ReturnType<typeof createServerFacade>): void {
    dispose = installClaudePermissionDenyTranscriptWatch(facade.server, { settleMs: 20 })
  }

  it('infers a deny when the rejected tool_result is appended', async () => {
    const facade = createServerFacade()
    install(facade)
    const event = waitEvent(transcriptPath)
    facade.emit(event)

    await settle(40)
    await appendFile(transcriptPath, denyLine())
    await vi.waitFor(() => expect(facade.infer).toHaveBeenCalledTimes(1), { timeout: 2_000 })
    expect(facade.infer).toHaveBeenCalledWith({
      paneKey: PANE_KEY,
      baselineUpdatedAt: event.receivedAt,
      baselineStateStartedAt: event.stateStartedAt,
      baselinePrompt: 'make probe',
      baselineAgentType: 'claude'
    })
  })

  it('infers from a deny already on disk when the wait is observed late', async () => {
    await appendFile(transcriptPath, denyLine())
    const facade = createServerFacade()
    install(facade)
    facade.emit(waitEvent(transcriptPath))

    await vi.waitFor(() => expect(facade.infer).toHaveBeenCalledTimes(1), { timeout: 2_000 })
  })

  it('gives up when the watch cannot bind, without polling', async () => {
    const missingDirPath = join(dir, 'missing', 'session.jsonl')
    const facade = createServerFacade()
    install(facade)
    facade.emit(waitEvent(missingDirPath))

    await settle(40)
    await mkdir(join(dir, 'missing'))
    await writeFile(missingDirPath, denyLine())
    await settle(150)
    expect(facade.infer).not.toHaveBeenCalled()
  })

  it.each([
    ['a different tool_use_id', denyLine('toolu_other')],
    ['a successful tool_result for the pending tool', successLine()]
  ])('ignores %s', async (_label, line) => {
    const facade = createServerFacade()
    install(facade)
    facade.emit(waitEvent(transcriptPath))

    await settle(40)
    await appendFile(transcriptPath, line)
    await settle(150)
    expect(facade.infer).not.toHaveBeenCalled()
  })

  it('stops when a newer status replaces the wait', async () => {
    const facade = createServerFacade()
    install(facade)
    facade.emit(waitEvent(transcriptPath))
    facade.emit(
      waitEvent(transcriptPath, {
        receivedAt: Date.now() + 10,
        payload: { state: 'working', agentType: 'claude', prompt: 'make probe' }
      })
    )

    await appendFile(transcriptPath, denyLine())
    await settle(150)
    expect(facade.infer).not.toHaveBeenCalled()
  })

  it.each([
    ['no tool_use_id', (path: string) => waitEvent(path, { toolUseId: undefined })],
    ['a remote pane', (path: string) => waitEvent(path, { connectionId: 'ssh-1' })],
    ['no transcript path', (path: string) => waitEvent(path, { providerSession: {} })],
    [
      'an AskUserQuestion wait',
      (path: string) =>
        waitEvent(path, {
          payload: {
            state: 'waiting',
            agentType: 'claude',
            toolName: 'AskUserQuestion',
            prompt: 'make probe'
          }
        })
    ]
  ])('does not watch %s', async (_label, makeEvent) => {
    const facade = createServerFacade()
    install(facade)
    facade.emit(makeEvent(transcriptPath))

    await appendFile(transcriptPath, denyLine())
    await settle(150)
    expect(facade.infer).not.toHaveBeenCalled()
  })

  it('dispose cancels pending watchers', async () => {
    const facade = createServerFacade()
    install(facade)
    facade.emit(waitEvent(transcriptPath))
    dispose?.()
    dispose = null

    await appendFile(transcriptPath, denyLine())
    await settle(150)
    expect(facade.infer).not.toHaveBeenCalled()
  })
})

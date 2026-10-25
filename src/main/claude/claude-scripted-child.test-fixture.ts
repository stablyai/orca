// Claude's scripted child for the registration matrix: the real Claude adapter over a scripted
// stream-json connection. Its handshake is the CLI's initialize answer.

import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  ClaudeStreamJsonConnection,
  ClaudeStreamJsonLaunch,
  openClaudeStreamJsonConnection
} from './claude-stream-json-connection'
import type {
  ScriptedAgentChild,
  ScriptedAgentChildFactory
} from '../runtime/structured-agent-scripted-child.test-fixture'
import { scriptedClaudeExitError } from '../runtime/structured-claude-scripted-runtime-test-support'
import { result, says } from './claude-captured-frame-builders.test-fixture'

type Spawned = {
  connection: Omit<ClaudeStreamJsonConnection, 'closed' | 'exitVerdict'> & {
    closed: boolean
    exitVerdict: ClaudeStreamJsonConnection['exitVerdict']
  }
  answer: () => void
  fail: (message: string) => void
}

function promptText(message: Record<string, unknown>): string {
  const inner = message.message
  const content =
    inner && typeof inner === 'object' && 'content' in inner ? inner.content : undefined
  const blocks = Array.isArray(content) ? content : []
  return blocks
    .map((block: unknown) =>
      block && typeof block === 'object' && 'text' in block ? String(block.text) : ''
    )
    .join('')
}

/** The CLI writes its transcript as a conversation's first message lands; a later start resumes it. */
function writeTranscript(launch: ClaudeStreamJsonLaunch, providerSessionId: string): void {
  const home = launch.env?.CLAUDE_CONFIG_DIR
  if (!home) {
    return
  }
  const folder = join(home, 'projects', 'scripted')
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, `${providerSessionId}.jsonl`), '{}\n')
}

export const claudeScriptedChild: ScriptedAgentChildFactory = () => {
  const spawned: Spawned[] = []
  const prompts: string[] = []
  let resumes = 0
  let closes = 0
  const openConnection: typeof openClaudeStreamJsonConnection = async (launch, handlers = {}) => {
    if (launch.options.resume !== undefined) {
      resumes += 1
    }
    const providerSessionId = String(launch.options.sessionId ?? launch.options.resume)
    const initialized = { models: [{ value: 'sonnet', displayName: 'Sonnet' }] }
    let answer = (): void => {}
    let reject = (_error: Error): void => {}
    const init = new Promise<typeof initialized>((resolve, fail) => {
      answer = () => {
        handlers.onMessage?.({
          type: 'system',
          subtype: 'init',
          session_id: providerSessionId,
          model: 'claude-sonnet-5',
          apiKeySource: 'none'
        })
        resolve(initialized)
      }
      reject = fail
    })
    if (!child.holdHandshakes) {
      answer()
    }
    const connection: Spawned['connection'] = {
      pid: 7000 + spawned.length,
      closed: false,
      exitVerdict: { root: 'live', tree: 'unverifiable' },
      initializationResult: () => init,
      getContextUsage: async () => ({}),
      getSettings: async () => ({ effective: {} }),
      supportedModels: async () => [{ value: 'sonnet', displayName: 'Sonnet' }],
      setModel: async () => {},
      setPermissionMode: async () => {},
      applyFlagSettings: async () => {},
      interrupt: async () => undefined,
      cancelAsyncMessage: async () => false,
      stopTask: async () => {},
      send: async (message, beforeDispatch) => {
        await beforeDispatch?.()
        prompts.push(promptText(message))
        writeTranscript(launch, providerSessionId)
        // The CLI echoes each message it takes under the client's uuid: Orca's proof of delivery.
        handlers.onMessage?.({
          type: 'user',
          session_id: providerSessionId,
          parent_tool_use_id: null,
          uuid: message.uuid,
          isReplay: true,
          message: message.message
        })
        if (child.completeTurns) {
          const id = randomUUID()
          handlers.onMessage?.({ ...says(id, 'done', null), session_id: providerSessionId })
          handlers.onMessage?.({ ...result('success'), session_id: providerSessionId, uuid: id })
        }
      },
      close: async () => {
        if (!connection.closed) {
          connection.closed = true
          closes += 1
          connection.exitVerdict = { root: 'exited', tree: 'exited' }
          handlers.onExit?.(new Error('closed by Orca'))
        }
        return true
      }
    }
    spawned.push({
      connection,
      answer,
      fail: (message) => {
        const error = scriptedClaudeExitError(message)
        connection.closed = true
        connection.exitVerdict = { root: 'exited', tree: 'unverifiable' }
        reject(error)
        handlers.onExit?.(error)
      }
    })
    return connection
  }
  const newest = (): Spawned => {
    const latest = spawned.at(-1)
    if (!latest) {
      throw new Error('no Claude child was spawned')
    }
    return latest
  }
  const child: ScriptedAgentChild = {
    deps: {
      openClaudeConnection: openConnection,
      readProcessStartTime: async (pid) =>
        spawned.find((entry) => entry.connection.pid === pid)?.connection.exitVerdict.root ===
        'exited'
          ? null
          : pid * 10,
      resolveClaudeCommand: () => '/nonexistent/scripted-claude',
      resolveClaudeAuthPolicy: () => ({ account: 'system' })
    },
    holdHandshakes: true,
    releaseHandshake: () => newest().answer(),
    failHandshake: (message) => newest().fail(message),
    completeTurns: true,
    prompts: () => prompts,
    spawns: () => spawned.length,
    resumes: () => resumes,
    closes: () => closes
  }
  return child
}

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status-types'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { mergeNativeChatMessages } from '../../../../shared/native-chat-merge'
import { foldToolMessages, pairToolBlocks } from '../../../../shared/native-chat-tool-fold'
import type { IFilesystemProvider } from '../../../providers/types'
import {
  registerSshFilesystemProvider,
  unregisterSshFilesystemProvider
} from '../../../providers/ssh-filesystem-dispatch'
import { eraseRpcMethods, type RpcContext } from '../core'
import { NATIVE_CHAT_METHODS } from './native-chat'

const CONNECTION_ID = 'ssh-target-26057'
const SESSION_ID = 'claude-session-26057'

let hookRows: Partial<AgentStatusIpcPayload>[] = []

function claudeLines(...texts: string[]): string {
  return texts
    .map((text, index) =>
      JSON.stringify({
        sessionId: SESSION_ID,
        uuid: `${SESSION_ID}-${index}`,
        timestamp: '2026-10-07T03:00:00.000Z',
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text }] }
      })
    )
    .map((line) => `${line}\n`)
    .join('')
}

/** An SSH host's filesystem as the relay serves it: stat plus positional reads. */
function sshHost(files: Map<string, string>): IFilesystemProvider {
  const bytes = (path: string): Buffer => {
    const body = files.get(path)
    if (body === undefined) {
      // As the relay delivers it: the multiplexer swaps Node's 'ENOENT' code for its transport code.
      const error = new Error(`ENOENT: no such file or directory, lstat '${path}'`)
      Object.defineProperty(error, 'code', { value: -32000 })
      throw error
    }
    return Buffer.from(body)
  }
  const provider: Pick<IFilesystemProvider, 'stat' | 'readFileRange'> = {
    stat: async (path) => ({
      size: bytes(path).length,
      type: 'file',
      mtime: 0,
      mtimeMs: bytes(path).length,
      dev: 1,
      ino: 1
    }),
    readFileRange: async (path, position, length) => {
      const slice = bytes(path).subarray(position, position + length)
      return { bytes: slice, bytesRead: slice.length }
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: transcript reads use only stat and readFileRange.
  return provider as IFilesystemProvider
}

function sshHookRow(transcriptPath: string): Partial<AgentStatusIpcPayload> {
  return {
    paneKey: 'tab-1:leaf-1',
    connectionId: CONNECTION_ID,
    agentType: 'claude',
    providerSession: { key: 'session_id', id: SESSION_ID, transcriptPath }
  }
}

const METHODS = eraseRpcMethods(NATIVE_CHAT_METHODS)

type SubscriptionRuntime = Pick<
  RpcContext['runtime'],
  'registerSubscriptionCleanup' | 'cleanupSubscription'
>

function phoneContext(runtime: Partial<SubscriptionRuntime>): RpcContext {
  const members = { ...runtime, getAgentProviderSessionRows: () => hookRows }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: native chat handlers use only the hook rows and the subscription-cleanup members.
  const handlerRuntime = members as unknown as RpcContext['runtime']
  return { runtime: handlerRuntime, connectionId: 'phone-1', clientKind: 'mobile' }
}

function method(name: string): (typeof METHODS)[number] {
  const found = METHODS.find((candidate) => candidate.name === name)
  if (!found) {
    throw new Error(`${name} is not registered`)
  }
  return found
}

function texts(value: unknown): string[] {
  if (!value || typeof value !== 'object' || !('messages' in value)) {
    return []
  }
  const messages: readonly NativeChatMessage[] = Array.isArray(value.messages) ? value.messages : []
  return messages.flatMap((message) =>
    message.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : []))
  )
}

async function readSession(
  transcriptPath: string
): Promise<{ texts: string[]; error: unknown; notFound: unknown }> {
  const read = method('nativeChat.readSession')
  if ('stream' in read) {
    throw new Error('nativeChat.readSession is a stream')
  }
  const page = await read.handler(
    { agent: 'claude', sessionId: SESSION_ID, transcriptPath },
    phoneContext({})
  )
  return {
    texts: texts(page),
    error: page && typeof page === 'object' && 'error' in page ? page.error : undefined,
    notFound: page && typeof page === 'object' && 'notFound' in page ? page.notFound : undefined
  }
}

describe('native chat for an agent whose transcript lives on an SSH host (#26057)', () => {
  let localDir: string
  // The path the remote hook reported. A same-named file exists on this machine too, so a read
  // that answers locally shows the wrong conversation instead of failing quietly.
  let transcriptPath: string

  beforeEach(() => {
    localDir = mkdtempSync(join(tmpdir(), 'orca-ssh-transcript-'))
    transcriptPath = join(localDir, 'projects', 'p', `${SESSION_ID}.jsonl`)
    mkdirSync(dirname(transcriptPath), { recursive: true })
    writeFileSync(transcriptPath, claudeLines('LOCAL MACHINE FILE'))
    hookRows = [sshHookRow(transcriptPath)]
  })

  afterEach(() => {
    unregisterSshFilesystemProvider(CONNECTION_ID)
    rmSync(localDir, { recursive: true, force: true })
  })

  it('reads the history from the SSH host the hook store attests the session to', async () => {
    registerSshFilesystemProvider(
      CONNECTION_ID,
      sshHost(new Map([[transcriptPath, claudeLines('first remote turn', 'second remote turn')]]))
    )

    const page = await readSession(transcriptPath)

    expect(page.error).toBeUndefined()
    expect(page.texts).toEqual(['first remote turn', 'second remote turn'])
  })

  it('publishes raw provider order to old peers without private folded-result markers', async () => {
    const records = [
      {
        type: 'assistant',
        uuid: 'a',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'a' } }]
        }
      },
      {
        type: 'user',
        uuid: 'old-x',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'x', content: 'OLD X' }]
        }
      },
      {
        type: 'assistant',
        uuid: 'x',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: { command: 'x' } }]
        }
      }
    ]
    registerSshFilesystemProvider(
      CONNECTION_ID,
      sshHost(
        new Map([
          [transcriptPath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`]
        ])
      )
    )
    const read = method('nativeChat.readSession')
    if ('stream' in read) {
      throw new Error('nativeChat.readSession is a stream')
    }
    const page = await read.handler(
      { agent: 'claude', sessionId: SESSION_ID, transcriptPath },
      phoneContext({})
    )
    if (
      !page ||
      typeof page !== 'object' ||
      !('messages' in page) ||
      !Array.isArray(page.messages)
    ) {
      throw new Error('nativeChat.readSession did not publish messages')
    }
    const published: NativeChatMessage[] = page.messages
    expect(published.map((message) => message.id)).toEqual(['a', 'old-x', 'x'])
    expect(published.every((message) => !Object.hasOwn(message, 'unpairedToolResults'))).toBe(true)
    const oldPeerRoundTrip: NativeChatMessage[] = JSON.parse(JSON.stringify(published))
    const projected = foldToolMessages(oldPeerRoundTrip)
    expect(pairToolBlocks(projected[0]!.blocks).every((pair) => pair.result === undefined)).toBe(
      true
    )
    expect(projected[1]).toMatchObject({ id: 'old-x', role: 'tool', blocks: [{ output: 'OLD X' }] })
    expect(foldToolMessages(projected)).toEqual(projected)
  })

  it('keeps remote page cursors and reattaches several outputs to their earlier named calls', async () => {
    const records = [
      {
        type: 'user',
        uuid: 'prompt',
        message: { role: 'user', content: [{ type: 'text', text: 'remote question' }] }
      },
      ...['a', 'b'].map((id) => ({
        type: 'assistant',
        uuid: `call-${id}`,
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id, name: 'Bash', input: { command: id } }]
        }
      })),
      {
        type: 'assistant',
        uuid: 'backlog',
        message: {
          role: 'assistant',
          content: Array.from({ length: 64 }, (_, index) => ({
            type: 'tool_use',
            id: `silent-${index}`,
            name: 'Bash',
            input: { command: `silent ${index}` }
          }))
        }
      },
      {
        type: 'user',
        uuid: 'outputs',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'a', content: 'output A' },
            { type: 'tool_result', tool_use_id: 'b', content: 'output B', is_error: true }
          ]
        }
      }
    ]
    const lines = records.map((record) => `${JSON.stringify(record)}\n`)
    const cursor = Buffer.byteLength(lines.slice(0, 3).join(''))
    registerSshFilesystemProvider(
      CONNECTION_ID,
      sshHost(new Map([[transcriptPath, lines.join('')]]))
    )
    const read = method('nativeChat.readSession')
    if ('stream' in read) {
      throw new Error('nativeChat.readSession is a stream')
    }
    const readPage = read.handler
    async function page(limit: number, beforeOffset?: number) {
      const result = await readPage(
        { agent: 'claude', sessionId: SESSION_ID, transcriptPath, limit, beforeOffset },
        phoneContext({})
      )
      if (
        !result ||
        typeof result !== 'object' ||
        !('messages' in result) ||
        !Array.isArray(result.messages) ||
        !('beforeOffset' in result) ||
        !('hasMore' in result)
      ) {
        throw new Error('nativeChat.readSession did not publish a page')
      }
      const messages: NativeChatMessage[] = result.messages
      return { messages, beforeOffset: result.beforeOffset, hasMore: result.hasMore }
    }
    const tail = await page(2)
    expect(tail.beforeOffset).toBe(cursor)
    expect(tail.hasMore).toBe(true)
    expect(tail.messages.map((row) => row.id)).toEqual(['backlog', 'outputs'])
    expect(tail.messages.every((row) => !Object.hasOwn(row, 'unpairedToolResults'))).toBe(true)
    const partial = foldToolMessages(tail.messages)
    expect(partial[1]).toMatchObject({
      id: 'outputs',
      role: 'tool',
      blocks: [{ output: 'output A' }, { output: 'output B', isError: true }]
    })
    expect(pairToolBlocks(partial[0]!.blocks).every((pair) => pair.result === undefined)).toBe(true)
    expect(foldToolMessages(partial)).toEqual(partial)

    const older = await page(100, cursor)
    expect(older.beforeOffset).toBe(0)
    expect(older.hasMore).toBe(false)
    expect(older.messages.map((row) => row.id)).toEqual(['prompt', 'call-a', 'call-b'])
    const raw = mergeNativeChatMessages(older.messages, tail.messages)
    expect(raw.every((row) => !Object.hasOwn(row, 'unpairedToolResults'))).toBe(true)
    const whole = foldToolMessages(raw)
    expect(whole.some((row) => row.role === 'tool')).toBe(false)
    expect(
      whole.flatMap((row) =>
        pairToolBlocks(row.blocks).flatMap((pair) =>
          pair.result ? [[pair.call?.callId, pair.result.output]] : []
        )
      )
    ).toEqual([
      ['a', 'output A'],
      ['b', 'output B']
    ])
    expect(foldToolMessages(whole)).toEqual(whole)
    expect(tail.beforeOffset).toBe(cursor)
  })

  it('streams the SSH host history and its later turns to a subscribed phone', async () => {
    const files = new Map([[transcriptPath, claudeLines('remote history')]])
    registerSshFilesystemProvider(CONNECTION_ID, sshHost(files))
    const frames: unknown[] = []
    let cleanup = (): void => {}
    const subscribe = method('nativeChat.subscribe')
    if (!('stream' in subscribe)) {
      throw new Error('nativeChat.subscribe is not a stream')
    }

    await subscribe.handler(
      { agent: 'claude', sessionId: SESSION_ID, transcriptPath, subscriptionId: 'sub-1' },
      phoneContext({
        registerSubscriptionCleanup: (_id, fn) => {
          cleanup = fn
        },
        cleanupSubscription: () => cleanup()
      }),
      (frame) => frames.push(frame)
    )
    try {
      await vi.waitFor(() => expect(texts(frames[0])).toEqual(['remote history']))
      files.set(transcriptPath, claudeLines('remote history', 'remote follow-up'))
      await vi.waitFor(
        () =>
          expect(
            frames
              .filter(
                (frame) =>
                  frame && typeof frame === 'object' && 'type' in frame && frame.type === 'appended'
              )
              .flatMap((frame) => texts(frame))
          ).toEqual(['remote follow-up']),
        { timeout: 5_000 }
      )
    } finally {
      cleanup()
    }
  })

  it('reads a transcript the SSH host has not written yet as not found, so the chat keeps waiting', async () => {
    registerSshFilesystemProvider(CONNECTION_ID, sshHost(new Map()))

    const page = await readSession(transcriptPath)

    expect(page.texts).toEqual([])
    expect(page.notFound).toBe(true)
  })

  it('never answers from this machine while the SSH host is disconnected', async () => {
    const page = await readSession(transcriptPath)

    expect(page.texts).toEqual([])
    expect(page.error).toBeDefined()
  })

  it('keeps reading a local session from this machine', async () => {
    hookRows = [{ ...sshHookRow(transcriptPath), connectionId: null }]

    const page = await readSession(transcriptPath)

    expect(page.texts).toEqual(['LOCAL MACHINE FILE'])
  })
})

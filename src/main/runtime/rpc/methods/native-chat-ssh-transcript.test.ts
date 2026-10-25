import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status-types'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
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
  // A same-named local transcript must not override the remote hook's conversation.
  let transcriptPath: string

  beforeEach(() => {
    localDir = mkdtempSync(join(tmpdir(), 'orca-ssh-transcript-'))
    transcriptPath = join(localDir, 'projects', 'p', `${SESSION_ID}.jsonl`)
    mkdirSync(dirname(transcriptPath), { recursive: true })
    writeFileSync(transcriptPath, claudeLines('LOCAL MACHINE FILE'))
    hookRows = [sshHookRow(transcriptPath)]
  })

  afterEach(() => {
    rmSync(localDir, { recursive: true, force: true })
  })

  it('never answers from this machine for an SSH-hosted transcript', async () => {
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

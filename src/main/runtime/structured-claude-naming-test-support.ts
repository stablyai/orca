import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { claudeProviderHandle } from '../../shared/agent-session-provider-handle-encoding'
import { appendTranscriptEntries } from '../claude/claude-provider-session-rename'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import { fakeClaude, type FakeConnection } from '../claude/claude-structured-session-test-support'
import type { ClaudeStreamJsonLaunch } from '../claude/claude-stream-json-connection'
import { createStructuredChatNamingHandler } from '../native-chat/structured-chat-naming'
import {
  createTestParams,
  CREATE_TEST_CALLER
} from '../native-chat/agent-session-wire/structured-agent-session-create-test-fixture'
import {
  hostTestMessage,
  HOST_TEST_SESSION
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { createStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import { closeTestJournalHostDatabase } from '../native-chat/agent-session-journal/journal-host-database-test-support'
import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime
} from './structured-agent-session-runtime'
import type { StructuredAgentSessionRuntimeDeps } from './structured-agent-session-runtime'

export async function writeNativeNamingConversation(
  path: string,
  nativeId: string,
  cwd: string,
  title = 'Old'
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const rows = [
    {
      type: 'user',
      uuid: randomUUID(),
      parentUuid: null,
      sessionId: nativeId,
      cwd,
      timestamp: '2026-10-27T00:00:00.000Z',
      message: { role: 'user', content: 'Imported prompt' }
    },
    { type: 'custom-title', sessionId: nativeId, customTitle: title },
    { type: 'agent-name', agentName: title, sessionId: nativeId }
  ]
  await writeFile(path, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`)
}

export async function nativeNamingTitle(path: string): Promise<string | undefined> {
  let title: string | undefined
  for (const line of (await readFile(path, 'utf8')).split('\n')) {
    try {
      const value: unknown = JSON.parse(line)
      if (
        value &&
        typeof value === 'object' &&
        'type' in value &&
        value.type === 'custom-title' &&
        'customTitle' in value &&
        typeof value.customTitle === 'string'
      ) {
        title = value.customTitle
      }
    } catch {
      /* Native readers tolerate crash-torn rows. */
    }
  }
  return title
}

/** Production host, journal, routing, launch, dispatch and settlement; only the native child is scripted. */
export async function createClaudeNamingRuntime(
  options: {
    initialize?: Promise<void>
    beforeOpen?: (launch: ClaudeStreamJsonLaunch, connection: FakeConnection) => Promise<void>
    beforeClose?: (connection: FakeConnection) => Promise<boolean>
    beforeControl?: (connection: FakeConnection, name: string) => Promise<void>
    deps?: Partial<StructuredAgentSessionRuntimeDeps>
  } = {}
) {
  const root = await mkdtemp(join(tmpdir(), 'orca-claude-naming-'))
  const home = join(root, 'claude-home')
  await mkdir(home)
  const nativeId = randomUUID()
  const file = join(home, 'projects', root.replace(/[^a-zA-Z0-9]/g, '-'), `${nativeId}.jsonl`)
  const controls: { name: string; nativeId: string }[] = []
  const launches: ClaudeStreamJsonLaunch[] = []
  let host: StructuredAgentSessionHost | undefined
  const logger = createStructuredAgentSessionLogger()
  const naming = createStructuredChatNamingHandler({
    getStore: () => host?.deps.store ?? null,
    getSettings: () => ({ nativeChatAutoName: false }),
    readFirstPrompt: async () => '',
    readJournalFirstPrompt: async () => '',
    workerTaskTitle: () => null,
    generate: async () => null,
    onNamed: () => {},
    logger
  })
  let operation = 0
  const operationId = () => `${Date.now()}-${(++operation).toString(16).padStart(32, '0')}`
  const nativeOptions: { initSessionId: string; holdInit: boolean } = {
    initSessionId: nativeId,
    holdInit: options.initialize !== undefined
  }
  const native = fakeClaude(nativeOptions)
  const install = async () => {
    host = await ensureStructuredAgentSessionHost({
      stateDirectory: root,
      hostId: 'local',
      claimKeyId: 'naming-test',
      logger,
      resolveWorkspacePath: async () => root,
      resolveClaudeCommand: () => ({ command: process.execPath, prefixArgs: [] }),
      resolveLaunchArgs: () => [],
      resolveClaudeAuthPolicy: () => ({ account: 'system' }),
      resolveEnvironment: async () => ({
        HOME: root,
        USERPROFILE: root,
        PATH: process.env.PATH ?? ''
      }),
      readProcessStartTime: async () => 5000,
      conversationNaming: naming,
      openClaudeConnection: async (launch, handlers) => {
        launches.push(launch)
        const target = launch.options.resume ?? launch.options.sessionId
        if (typeof target !== 'string') {
          throw new Error('expected the production UUID launch')
        }
        const targetFile = join(dirname(file), `${target}.jsonl`)
        nativeOptions.initSessionId = target
        const connection = await native.openConnection(launch, handlers)
        const actual = native.connections.find((candidate) => candidate === connection)
        if (!actual) {
          throw new Error('native fixture did not create its connection')
        }
        void options.initialize?.then(
          () => actual.initialization.resolve(),
          (error: unknown) => actual.initialization.reject(error)
        )
        let remembered: string | undefined
        try {
          remembered = await nativeNamingTitle(targetFile)
        } catch (error) {
          if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
            throw error
          }
          await writeNativeNamingConversation(targetFile, target, launch.cwd)
          remembered = 'Old'
        }
        connection.renameSession = async (name, target) => {
          controls.push({ name, nativeId: target })
          await options.beforeControl?.(actual, name)
          remembered = name
          await appendTranscriptEntries(targetFile, [
            { type: 'custom-title', sessionId: target, customTitle: name },
            { type: 'agent-name', agentName: name, sessionId: target }
          ])
        }
        let closing: Promise<boolean> | undefined
        connection.close = () =>
          (closing ??= (async () => {
            actual.closed = true
            actual.closeCount++
            actual.initialization.dispose()
            const proven = (await options.beforeClose?.(actual)) ?? true
            if (proven) {
              if (remembered !== undefined) {
                await appendTranscriptEntries(targetFile, [
                  { type: 'custom-title', sessionId: target, customTitle: remembered },
                  { type: 'agent-name', agentName: remembered, sessionId: target }
                ])
              }
              actual.exitVerdict = { root: 'exited', tree: 'exited' }
            } else {
              closing = undefined
            }
            return proven
          })())
        connection.send = async (message, beforeDispatch) => {
          await beforeDispatch?.()
          actual.sent.push(message)
          handlers?.onMessage?.({
            type: 'system',
            subtype: 'init',
            session_id: target,
            model: 'claude-sonnet-5'
          })
          const assistant = {
            type: 'assistant' as const,
            session_id: target,
            uuid: randomUUID(),
            message: {
              id: randomUUID(),
              role: 'assistant',
              content: [{ type: 'text', text: 'NAMING_OK' }],
              stop_reason: 'end_turn',
              usage: { input_tokens: 1, output_tokens: 1 }
            }
          }
          const rows: { type: string; uuid?: string }[] = (await readFile(targetFile, 'utf8'))
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line))
          const parentUuid =
            rows.findLast((row) => row.type === 'user' || row.type === 'assistant')?.uuid ?? null
          const user = {
            ...message,
            sessionId: target,
            cwd: launch.cwd,
            parentUuid,
            timestamp: new Date().toISOString()
          }
          await appendFile(
            targetFile,
            `${JSON.stringify(user)}\n${JSON.stringify({ ...assistant, sessionId: target, cwd: launch.cwd, parentUuid: message.uuid, timestamp: new Date().toISOString() })}\n`
          )
          handlers?.onMessage?.({ ...message, session_id: target })
          handlers?.onMessage?.(assistant)
          handlers?.onMessage?.({
            type: 'result',
            subtype: 'success',
            session_id: target,
            result: 'NAMING_OK',
            total_cost_usd: 0,
            duration_ms: 1,
            duration_api_ms: 1,
            num_turns: 1,
            is_error: false,
            usage: { input_tokens: 1, output_tokens: 1 }
          })
        }
        try {
          await options.beforeOpen?.(launch, actual)
        } catch (error) {
          await connection.close()
          throw error
        }
        return connection
      },
      ...options.deps
    })
    return host
  }
  return {
    root,
    home,
    file,
    nativeId,
    launches,
    controls,
    native,
    install,
    operationId,
    async create(source: string | null = file, sessionId = HOST_TEST_SESSION) {
      if (!host) {
        throw new Error('install the runtime first')
      }
      const params = createTestParams(
        undefined,
        {
          provider: 'claude',
          agent: 'claude',
          accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: home },
          adopt: source
            ? { providerHandle: claudeProviderHandle(nativeId, null), transcriptPath: source }
            : undefined
        },
        sessionId
      )
      return host.create(CREATE_TEST_CALLER, {
        ...params,
        envelope: { ...params.envelope, clientOperationId: operationId() }
      })
    },
    async send(text = 'Fresh naming reply', sessionId = HOST_TEST_SESSION) {
      if (!host) {
        throw new Error('install the runtime first')
      }
      const body = hostTestMessage(text)
      return host.send(CREATE_TEST_CALLER, {
        envelope: {
          sessionId,
          clientOperationId: operationId(),
          expectedRuntimeFence: host.deps.store.requireWritableRecord(sessionId).lease.runtimeFence,
          payloadFingerprint: computeAgentSessionPayloadFingerprint({
            method: 'agentSession.send',
            sessionId,
            fields: { body }
          })
        },
        body
      })
    },
    async dispose() {
      native.dispose()
      await stopStructuredAgentSessionRuntime()
      closeTestJournalHostDatabase(root)
      await rm(root, { recursive: true, force: true })
    }
  }
}

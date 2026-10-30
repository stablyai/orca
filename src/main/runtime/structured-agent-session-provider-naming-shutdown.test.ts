import { ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { expect, it, vi } from 'vitest'
import { codexProviderHandle } from '../../shared/agent-session-provider-handle-encoding'
import * as processSpawn from '../codex/codex-app-server-process-tree-kill'
import { closeTestJournalHostDatabase } from '../native-chat/agent-session-journal/journal-host-database-test-support'
import { agentSessionRecordFixture } from '../native-chat/agent-session-record-test-fixture'
import { StructuredAgentSessionAdapterRouter } from '../native-chat/agent-session-wire/structured-agent-session-adapter-router'
import { createStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import { seedTestAgentSessionRecordStore } from './agent-session-record-store-test-harness'
import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime
} from './structured-agent-session-runtime'

vi.mock('./structured-agent-model-catalog-wiring', () => ({
  modelCatalogHostDeps: async () => ({})
}))

it('stops naming admission and joins native helper finalization before runtime close', async ({
  onTestFinished
}) => {
  const root = await mkdtemp(join(tmpdir(), 'orca-naming-shutdown-'))
  const sessionId = 'chat-shutdown-1'
  const argumentsReady = Promise.withResolvers<string[]>()
  const stdinEnded = Promise.withResolvers<void>()
  const helperExit = Promise.withResolvers<void>()
  const order: string[] = []
  const requests: unknown[] = []
  const child = Object.assign(new ChildProcess(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough()
  })
  child.stdin.setEncoding('utf8').on('data', (line: string) => {
    const message = JSON.parse(line)
    requests.push(message)
    if (typeof message.id === 'number') {
      child.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`)
    }
  })
  child.stdin.once('finish', () => {
    order.push('helper-stdin-end')
    stdinEnded.resolve()
    void helperExit.promise.then(() => {
      order.push('helper-exit')
      child.stdout.end()
      child.stderr.end()
      child.emit('exit', 0, null)
      child.emit('close', 0, null)
    })
  })
  const spawn = vi.spyOn(processSpawn, 'spawnCodexAppServerProcess').mockImplementation(() => child)
  onTestFinished(async () => {
    argumentsReady.resolve([])
    helperExit.resolve()
    await stopStructuredAgentSessionRuntime()
    await closeTestJournalHostDatabase(root)
    vi.restoreAllMocks()
    await rm(root, { recursive: true, force: true })
  })
  await seedTestAgentSessionRecordStore(root, {
    records: [
      agentSessionRecordFixture({
        sessionId,
        provider: 'codex',
        accountHome: { variable: 'CODEX_HOME', path: join(root, 'codex-home') },
        providerHandleChain: [
          {
            linkId: 'link-1',
            handle: codexProviderHandle('thread-1'),
            origin: 'created',
            mintedAtFence: 1,
            observedAt: 0
          }
        ],
        conversationName: 'Saved name',
        conversationNameSource: 'user'
      })
    ]
  })
  await closeTestJournalHostDatabase(root)
  const resolveLaunchArgs = vi.fn(() => argumentsReady.promise)
  const host = await ensureStructuredAgentSessionHost({
    stateDirectory: root,
    hostId: 'local',
    claimKeyId: 'key-1',
    logger: createStructuredAgentSessionLogger(),
    resolveWorkspacePath: async () => root,
    resolveCodexCommand: () => ({ command: process.execPath, prefixArgs: [] }),
    resolveEnvironment: async () => ({}),
    resolveLaunchArgs,
    resolveClaudeAuthPolicy: () => ({ account: 'managed' })
  })
  expect(host.deps.store.getRecord(sessionId)).toMatchObject({
    sessionId,
    provider: 'codex',
    conversationName: 'Saved name',
    conversationNameSource: 'user'
  })
  const adapter = host.deps.adapter
  if (!(adapter instanceof StructuredAgentSessionAdapterRouter)) {
    throw new Error('expected the installed runtime adapter router')
  }
  const closeAll = adapter.closeAll.bind(adapter)
  const closeAdapters = vi.spyOn(adapter, 'closeAll').mockImplementation(async () => {
    order.push('adapter-close')
    await closeAll()
  })
  const close = host.deps.journalDatabase.close.bind(host.deps.journalDatabase)
  const closeDatabase = vi.spyOn(host.deps.journalDatabase, 'close').mockImplementation(() => {
    order.push('database-close')
    return close()
  })
  const stopDelivery = vi.spyOn(host, 'stopDelivery')
  host.deps.nameProviderConversation?.(host.deps.store.requireWritableRecord(sessionId))
  await vi.waitFor(() => expect(resolveLaunchArgs).toHaveBeenCalledOnce())
  let stopped = false
  const stopping = stopStructuredAgentSessionRuntime().then(() => {
    stopped = true
  })
  await vi.waitFor(() => expect(stopDelivery).toHaveBeenCalledOnce())
  // A retained callback must neither admit a new push nor coalesce another pass.
  host.deps.nameProviderConversation?.(host.deps.store.requireWritableRecord(sessionId))
  expect(stopped).toBe(false)
  expect(closeAdapters).not.toHaveBeenCalled()
  expect(closeDatabase).not.toHaveBeenCalled()
  expect(spawn).not.toHaveBeenCalled()

  argumentsReady.resolve([])
  await stdinEnded.promise
  expect(requests).toEqual([
    {
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'orca_desktop', title: 'Orca', version: '0.0.0' } }
    },
    { method: 'initialized' },
    { id: 2, method: 'thread/name/set', params: { threadId: 'thread-1', name: 'Saved name' } }
  ])
  expect(stopped).toBe(false)
  expect(closeAdapters).not.toHaveBeenCalled()
  expect(closeDatabase).not.toHaveBeenCalled()
  helperExit.resolve()
  await stopping
  expect(spawn).toHaveBeenCalledOnce()
  expect(resolveLaunchArgs).toHaveBeenCalledOnce()
  expect(order).toEqual(['helper-stdin-end', 'helper-exit', 'adapter-close', 'database-close'])
  expect(closeAdapters).toHaveBeenCalledOnce()
  expect(host.deps.journalDatabase.isClosed).toBe(true)
  expect(closeDatabase).toHaveBeenCalledOnce()
})

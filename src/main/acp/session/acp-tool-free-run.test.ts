import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { KILO_LAUNCH_SPEC } from '../../kilo/kilo-acp-launch-spec'
import { QWEN_CODE_LAUNCH_SPEC } from '../../qwen-code/qwen-code-acp-launch-spec'
import { ACP_PROTOCOL_VERSION } from '../generated/acp-protocol.generated'
import type { AcpLaunchSpec } from '../launch/acp-launch-contract'
import { FakeAcpChild } from '../process/testing/acp-scripted-connection.test-fixture'
import { tick } from '../process/testing/acp-scripted-agent.test-support'
import { acquireAcpStructuredSession } from './acp-structured-acquire'
import { AcpStructuredChildren } from './children/acp-structured-child-lifecycle'

const ConfigOption = z.object({ configId: z.string(), value: z.string() })
const Settlement = z.object({ kind: z.literal('settlement'), resolution: z.unknown() })
const folders: string[] = []
afterEach(async () => {
  await Promise.all(folders.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/** Acquires and opens an ACP chat on a scripted agent, as a memory upkeep run or a chat. */
async function acquireRun(input: {
  toolFree: boolean
  spec?: AcpLaunchSpec
  permissionMode?: 'full-access'
}) {
  const spec = input.spec ?? KILO_LAUNCH_SPEC
  const dataDirectory = await mkdtemp(join(tmpdir(), 'orca-tool-free-data-'))
  const botFolder = await mkdtemp(join(tmpdir(), 'orca-tool-free-bot-'))
  const runFolder = await mkdtemp(join(dataDirectory, 'run-'))
  folders.push(dataDirectory, botFolder)
  const settled: unknown[] = []
  const steps: unknown[] = []
  const deps = {
    spec,
    resolveLaunch: async () => ({
      spec,
      command: 'agent',
      prefixArgs: [],
      args: ['acp'],
      cwd: botFolder,
      env: {},
      envToDelete: [],
      fullAccess: false,
      resume: null,
      ...(input.toolFree ? { toolFree: { cwd: runFolder } } : {})
    }),
    dataDirectory,
    connect: (spawn: never, options: never) => (child = new FakeAcpChild(spawn, options)),
    readProcessStartTime: async () => 1
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the scripted run reads only these deps
  const children = new AcpStructuredChildren(deps as never)
  let child: FakeAcpChild | undefined
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a scripted acquire reads only these fields
  const { session } = await acquireAcpStructuredSession({
    acquire: {
      identity: { sessionId: 'chat-1' },
      fence: 1,
      spawnToken: 'token',
      ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
      events: {
        tryAppendTransition: (transition: { steps: unknown[] }) => {
          steps.push(...transition.steps)
          return { accepted: true }
        }
      }
    },
    deps,
    generation: 'g1',
    abandoned: () => false,
    track: () => {},
    onExit: () => {},
    onConnectionLost: () => {},
    onSettled: (settlement: unknown) => settled.push(settlement),
    forceClose: (id: string, reason: string) => children.stopAfterFailure(id, reason),
    interrupt: (id: string, reason: string) => children.interrupt(id, reason)
  } as never)
  children.sessions.set('chat-1', session)
  const agent = child!.agent
  const configured: string[] = []
  agent.on('initialize', (frame) =>
    agent.reply(frame, { protocolVersion: ACP_PROTOCOL_VERSION, agentCapabilities: {} })
  )
  agent.on('session/new', (frame) => agent.reply(frame, { sessionId: 'agent-1' }))
  agent.on('session/set_config_option', (frame) => {
    const { configId, value } = ConfigOption.parse(frame.params)
    configured.push(value)
    agent.reply(frame, {
      configOptions: [
        {
          id: configId,
          name: 'Mode',
          type: 'select',
          category: 'mode',
          currentValue: value,
          options: []
        }
      ]
    })
  })
  await session.open(new AbortController().signal)
  return { session, child: child!, agent, botFolder, runFolder, settled, configured, steps }
}

const permission = {
  sessionId: 'agent-1',
  toolCall: { toolCallId: 'call-1', title: 'Write MEMORY.md' },
  options: [
    { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
    { optionId: 'deny', name: 'Deny', kind: 'reject_once' }
  ]
}
const toolCall = {
  sessionId: 'agent-1',
  update: {
    sessionUpdate: 'tool_call',
    toolCallId: 'call-1',
    title: 'Edit MEMORY.md',
    kind: 'edit'
  }
}

describe('a tool-free ACP run', () => {
  it('starts in its own folder and refuses every request', async () => {
    const { child, agent, botFolder, runFolder } = await acquireRun({ toolFree: true })
    expect(child.launch.cwd).toBe(runFolder)
    expect(await readdir(runFolder)).toEqual([])
    const answer = await agent.request(1, 'session/request_permission', permission)
    expect(answer.result).toEqual({ outcome: { outcome: 'selected', optionId: 'deny' } })
    const write = await agent.request(2, 'fs/write_text_file', {
      sessionId: 'agent-1',
      path: join(botFolder, 'MEMORY.md'),
      content: 'x'
    })
    expect(write.error?.code).toBe(-32601)
  })

  it('asks even when the chat chose full access, on an agent that enforces its own modes', async () => {
    const { configured } = await acquireRun({
      toolFree: true,
      spec: QWEN_CODE_LAUNCH_SPEC,
      permissionMode: 'full-access'
    })
    expect(configured).toEqual(['default'])
  })

  it('ends its turn interrupted at its first tool call, so a reply it still sends settles nothing', async () => {
    const { session, child, agent, settled, steps } = await acquireRun({ toolFree: true })
    // The process outlives the stop, as a real agent's does until it is killed.
    child.proveClose = () => new Promise(() => {})
    agent.on('session/prompt', (frame) => {
      agent.notify('session/update', toolCall)
      setImmediate(() => agent.reply(frame, { stopReason: 'end_turn' }))
    })
    session.turns!.dispatch({
      clientMessageId: 'tidy-1',
      prompt: [{ type: 'text', text: 'Tidy your memory' }],
      requestedAt: 1
    })
    for (let i = 0; i < 5; i++) {
      await tick()
    }
    const settlements = steps.flatMap((step) => {
      const read = Settlement.safeParse(step)
      return read.success ? [read.data.resolution] : []
    })
    expect(settlements).toEqual([
      expect.objectContaining({
        ending: expect.objectContaining({
          turns: 'running',
          end: expect.objectContaining({ state: 'interrupted' })
        })
      })
    ])
    expect(settled).toEqual([
      {
        clientMessageId: 'tidy-1',
        providerIdentity: { provider: 'orca', clientMessageId: 'tidy-1' }
      }
    ])
    expect(session.journalClosed).not.toBeNull()
  })

  it('leaves a chat in its own folder, with its chosen mode and its tool calls', async () => {
    const { child, agent, botFolder, settled } = await acquireRun({ toolFree: false })
    expect(child.launch.cwd).toBe(botFolder)
    agent.notify('session/update', toolCall)
    await tick()
    expect(settled).toEqual([])
    const chat = await acquireRun({
      toolFree: false,
      spec: QWEN_CODE_LAUNCH_SPEC,
      permissionMode: 'full-access'
    })
    expect(chat.configured).toEqual(['yolo'])
  })
})

import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { KILO_LAUNCH_SPEC } from '../../kilo/kilo-acp-launch-spec'
import { ACP_PROTOCOL_VERSION } from '../generated/acp-protocol.generated'
import { FakeAcpChild } from '../process/testing/acp-scripted-connection.test-fixture'
import { tick } from '../process/testing/acp-scripted-agent.test-support'
import { acquireAcpStructuredSession } from './acp-structured-acquire'

const folders: string[] = []
afterEach(async () => {
  await Promise.all(folders.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/** Acquires an ACP chat on a scripted agent and opens its session, as a memory upkeep run or a chat. */
async function acquireRun(toolFree: boolean) {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'orca-tool-free-data-'))
  const botFolder = await mkdtemp(join(tmpdir(), 'orca-tool-free-bot-'))
  folders.push(dataDirectory, botFolder)
  const stops: string[] = []
  let child: FakeAcpChild | undefined
  const launch = {
    spec: KILO_LAUNCH_SPEC,
    command: 'kilo',
    prefixArgs: [],
    args: ['acp'],
    cwd: botFolder,
    env: {},
    envToDelete: [],
    fullAccess: false,
    resume: null,
    ...(toolFree ? { toolFree: true } : {})
  }
  await acquireAcpStructuredSession({
    acquire: {
      identity: { sessionId: 'chat-1' },
      fence: 1,
      spawnToken: 'token',
      events: { tryAppendTransition: () => true }
    },
    deps: {
      spec: KILO_LAUNCH_SPEC,
      resolveLaunch: async () => launch,
      dataDirectory,
      connect: (spawn: never, options: never) => (child = new FakeAcpChild(spawn, options)),
      readProcessStartTime: async () => 1
    },
    generation: 'g1',
    abandoned: () => false,
    track: () => {},
    onExit: () => {},
    onConnectionLost: () => {},
    onSettled: () => {},
    forceClose: (_sessionId: string, reason: string) => stops.push(reason)
  } as never)
  const agent = child!.agent
  agent.on('initialize', (frame) =>
    agent.reply(frame, { protocolVersion: ACP_PROTOCOL_VERSION, agentCapabilities: {} })
  )
  agent.on('session/new', (frame) => agent.reply(frame, { sessionId: 'kilo-1' }))
  const cwd = child!.launch.cwd ?? ''
  await child!.start({ cwd, mcpServers: [] })
  return { cwd, agent, botFolder, stops }
}

const permission = {
  sessionId: 'kilo-1',
  toolCall: { toolCallId: 'call-1', title: 'Write MEMORY.md' },
  options: [
    { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
    { optionId: 'deny', name: 'Deny', kind: 'reject_once' }
  ]
}
const toolCall = {
  sessionId: 'kilo-1',
  update: {
    sessionUpdate: 'tool_call',
    toolCallId: 'call-1',
    title: 'Edit MEMORY.md',
    kind: 'edit'
  }
}

describe('a tool-free ACP run', () => {
  it('starts in an empty folder, refuses every request and is stopped at its first tool call', async () => {
    const { cwd, agent, botFolder, stops } = await acquireRun(true)
    expect(cwd).not.toBe(botFolder)
    expect(await readdir(cwd)).toEqual([])

    const answer = await agent.request(1, 'session/request_permission', permission)
    expect(answer.result).toEqual({ outcome: { outcome: 'selected', optionId: 'deny' } })
    const write = await agent.request(2, 'fs/write_text_file', {
      sessionId: 'kilo-1',
      path: join(botFolder, 'MEMORY.md'),
      content: 'x'
    })
    expect(write.error?.code).toBe(-32601)

    expect(stops).toEqual([])
    agent.notify('session/update', toolCall)
    await tick()
    expect(stops).toEqual([
      'Orca stopped Kilocode: it tried to use a tool in a run that needs none'
    ])
  })

  it('leaves a chat in its own folder and its tool calls running', async () => {
    const { cwd, agent, botFolder, stops } = await acquireRun(false)
    expect(cwd).toBe(botFolder)
    agent.notify('session/update', toolCall)
    await tick()
    expect(stops).toEqual([])
  })
})

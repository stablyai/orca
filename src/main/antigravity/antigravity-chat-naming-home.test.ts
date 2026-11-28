import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ACP_PROTOCOL_VERSION } from '../acp/generated/acp-protocol.generated'
import { FakeAcpChild } from '../acp/process/testing/acp-scripted-connection.test-fixture'
import { AcpTextTasks } from '../acp/text-task/acp-text-task'
import { ANTIGRAVITY_ACP_HOME } from '../../shared/agent-session/lifecycle/provider-handles/antigravity-session-origin'
import { agyCredentialPresence } from './agy-credential-presence'
import { ANTIGRAVITY_LAUNCH_SPEC } from './antigravity-acp-launch-spec'
import { antigravityHostAccountHome } from './antigravity-host-acp'

vi.mock('./agy-credential-presence', () => ({ agyCredentialPresence: vi.fn() }))

const folders: string[] = []
afterEach(async () => {
  await Promise.all(folders.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const SESSION = '0f0e0d0c-0b0a-4909-8807-060504030201'

async function nameChat(presence: 'present' | 'locked', agySettings?: unknown) {
  vi.mocked(agyCredentialPresence).mockResolvedValue(presence)
  const dataDirectory = await mkdtemp(join(tmpdir(), 'orca-agy-naming-data-'))
  const user = await mkdtemp(join(tmpdir(), 'orca-agy-naming-user-'))
  folders.push(dataDirectory, user)
  if (agySettings) {
    await mkdir(join(user, '.gemini', 'antigravity-cli'), { recursive: true })
    await writeFile(
      join(user, '.gemini', 'antigravity-cli', 'settings.json'),
      JSON.stringify(agySettings)
    )
  }
  const children: FakeAcpChild[] = []
  const tasks = new AcpTextTasks({
    spec: ANTIGRAVITY_LAUNCH_SPEC,
    dataDirectory,
    textTaskLaunch: {
      resolveEnvironment: async () => ({ HOME: user, USERPROFILE: user, PATH: '' }),
      resolveCommand: () => join(user, 'bin', 'agy'),
      resolveCommandSettings: () => ({ antigravityChatAuth: { method: 'oauth-personal' } }),
      dataDirectory
    },
    connect: (launch, options) => {
      const child = new FakeAcpChild(launch, options)
      const { agent } = child
      const home = launch.args[launch.args.indexOf('--gemini-dir') + 1]!
      agent.on('initialize', (frame) =>
        agent.reply(frame, { protocolVersion: ACP_PROTOCOL_VERSION, agentCapabilities: {} })
      )
      agent.on('session/new', (frame) => agent.reply(frame, { sessionId: SESSION }))
      agent.on('session/set_config_option', (frame) => agent.reply(frame, { configOptions: [] }))
      agent.on('session/prompt', async (frame) => {
        // What agy keeps for any session it runs: the conversation and its summaries index.
        const appData = join(home, ANTIGRAVITY_ACP_HOME)
        await mkdir(join(appData, 'conversations'), { recursive: true })
        await writeFile(join(appData, 'conversations', `${SESSION}.db`), 'session')
        await writeFile(join(appData, 'conversation_summaries.db'), 'index')
        agent.notify('session/update', {
          sessionId: SESSION,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Fix the login bug' }
          }
        })
        agent.reply(frame, { stopReason: 'end_turn' })
      })
      children.push(child)
      return child
    }
  })
  const title = await tasks.generate({
    agent: 'antigravity',
    accountHome: antigravityHostAccountHome(user),
    prompt: 'Name this chat: the login button does nothing'
  })
  const homes = join(dataDirectory, 'acp-text-task-homes', 'antigravity')
  return { title, children, homes, user }
}

describe('Antigravity chat naming', () => {
  it('runs on a home of its own and removes it, session and all, once agy exits', async () => {
    const { title, children, homes, user } = await nameChat('present')

    expect(title).toBe('Fix the login bug')
    expect(children).toHaveLength(1)
    const args = children[0]!.launch.args
    const home = args[args.indexOf('--gemini-dir') + 1]!
    expect(home.startsWith(homes)).toBe(true)
    expect(home.startsWith(join(user, '.gemini'))).toBe(false)
    expect(children[0]!.exited).toBe(true)
    await vi.waitFor(async () => expect(await readdir(homes)).toEqual([]))
  })

  it('starts no agy where its keyring lookup could ask to unlock', async () => {
    const { title, children, homes } = await nameChat('locked')

    expect(title).toBeNull()
    expect(children).toHaveLength(0)
    await vi.waitFor(async () => expect(await readdir(homes)).toEqual([]))
  })

  it("starts no agy for a chat on agy's home that agy's own settings sign in differently", async () => {
    const { title, children } = await nameChat('present', { auth: { type: 'oauth-business' } })

    expect(title).toBeNull()
    expect(children).toHaveLength(0)
  })
})

import { chmod, mkdir, mkdtemp, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ACP_PROTOCOL_VERSION } from '../acp/generated/acp-protocol.generated'
import { FakeAcpChild } from '../acp/process/testing/acp-scripted-connection.test-fixture'
import { AcpTextTasks } from '../acp/text-task/acp-text-task'
import { sweepAcpTextTaskHomes } from '../acp/text-task/acp-text-task-launch'
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

async function nameChat(
  presence: 'present' | 'locked',
  agySettings?: unknown,
  /** A folder in the home no one can delete from, as one a scanner holds open. */
  heldFolder?: string
) {
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
        if (heldFolder) {
          await mkdir(join(home, heldFolder))
          await writeFile(join(home, heldFolder, 'token'), 'login')
          await chmod(join(home, heldFolder), 0o500)
        }
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
  return { title, children, homes, user, dataDirectory }
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

  // Permission bits don't stop Windows or root from deleting.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    "keeps a home it couldn't remove for the next sweep, which removes it",
    async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const { children, homes, dataDirectory } = await nameChat('present', undefined, 'held')
      const args = children[0]!.launch.args
      const home = args[args.indexOf('--gemini-dir') + 1]!
      try {
        await vi.waitFor(() =>
          expect(warn).toHaveBeenCalledWith(
            '[acp-text-task] A text task home is left for the next sweep:',
            expect.anything()
          )
        )
        expect(await readdir(homes)).toHaveLength(1)
      } finally {
        await chmod(join(home, 'held'), 0o700)
        warn.mockRestore()
      }

      // As at the next host start, or before the next naming run.
      await sweepAcpTextTaskHomes(dataDirectory, [ANTIGRAVITY_LAUNCH_SPEC])
      expect(await readdir(homes)).toEqual([])
    }
  )

  it('sweeps only run homes, and never through a link', async () => {
    const data = await mkdtemp(join(tmpdir(), 'orca-agy-naming-data-'))
    const outside = await mkdtemp(join(tmpdir(), 'orca-agy-naming-outside-'))
    folders.push(data, outside)
    const run = (n: number): string => `run-0f0e0d0c-0b0a-4909-8807-06050403020${n}`
    await mkdir(join(outside, run(1)))
    await writeFile(join(outside, 'keep'), 'not Orca’s')
    const root = join(data, 'acp-text-task-homes', 'antigravity')
    await mkdir(join(data, 'acp-text-task-homes'))
    await symlink(outside, root, 'junction')

    await sweepAcpTextTaskHomes(data, [ANTIGRAVITY_LAUNCH_SPEC])
    expect((await readdir(outside)).sort()).toEqual(['keep', run(1)])

    await unlink(root)
    await mkdir(root)
    await mkdir(join(root, run(2)))
    await writeFile(join(root, 'notes'), 'not a run home')
    await symlink(outside, join(root, run(3)), 'junction')

    await sweepAcpTextTaskHomes(data, [ANTIGRAVITY_LAUNCH_SPEC])
    expect(await readdir(root)).toEqual(['notes'])
    expect((await readdir(outside)).sort()).toEqual(['keep', run(1)])
  })

  it("starts no agy for a chat on agy's home that agy's own settings sign in differently", async () => {
    const { title, children } = await nameChat('present', { auth: { type: 'oauth-business' } })

    expect(title).toBeNull()
    expect(children).toHaveLength(0)
  })
})

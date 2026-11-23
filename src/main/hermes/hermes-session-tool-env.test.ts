import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { publishHermesSessionToolEnv } from './hermes-session-tool-env'
import { getPluginInitSource, HERMES_PLUGIN_GENERATION } from './hermes-managed-plugin-source'

let home: string
const file = () => join(home, 'orca-sessions', 'local-abc.json')
const publish = (token: string, live: () => boolean, bot?: { agentVersion?: string }) =>
  publishHermesSessionToolEnv({
    env: { HERMES_HOME: home },
    providerSessionId: 'local-abc',
    values: { ORCA_AGENT_SESSION_TOOL_TOKEN: token },
    live,
    mustReach: bot !== undefined,
    ...(bot?.agentVersion ? { agentVersion: bot.agentVersion } : {})
  })
const sessionsDir = () => join(home, 'orca-sessions')
// This test process stands in for the gateway: alive, and named by the profile's pid file.
const markGateway = async (generation: string) => {
  await writeFile(join(home, 'gateway.pid'), JSON.stringify({ pid: process.pid }))
  await mkdir(sessionsDir(), { recursive: true })
  await writeFile(join(sessionsDir(), `.loaded-${process.pid}`), generation)
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'orca-hermes-session-env-'))
  await mkdir(join(home, 'plugins', 'orca-status'), { recursive: true })
  await writeFile(join(home, 'plugins', 'orca-status', '__init__.py'), getPluginInitSource())
  await writeFile(join(home, 'config.yaml'), 'plugins:\n  enabled: [orca-status]\n')
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('publishHermesSessionToolEnv', () => {
  it("never lets an ended child's write or removal take a reopened chat's file", async () => {
    let oldLive = true
    const withdrawOld = await publish('old', () => oldLive)
    oldLive = false
    const withdrawNew = await publish('new', () => true)
    // The old child's write and its removal both land after the reopened chat published.
    await publish('late-old', () => oldLive)
    await withdrawOld()
    expect(JSON.parse(await readFile(file(), 'utf-8'))).toEqual({
      ORCA_AGENT_SESSION_TOOL_TOKEN: 'new'
    })

    await withdrawNew()
    await expect(readFile(file(), 'utf-8')).rejects.toThrow()
  })

  it("starts a bot's session only where its tools will carry the bot's identity", async () => {
    await markGateway(HERMES_PLUGIN_GENERATION)
    await expect(publish('bot', () => true, {})).resolves.toBeTypeOf('function')
    await expect(publish('bot', () => true, { agentVersion: '0.23.0' })).rejects.toMatchObject({
      installation: { minimumVersion: '0.23.1' }
    })
    // The gateway kept an older plugin, and nothing answers a reload.
    await markGateway('older-plugin')
    await expect(publish('bot', () => true, {})).rejects.toMatchObject({
      reason: 'botToolsGatewayOutdated'
    })
    // `hermes plugins disable` unloads it while its files and current mark stay.
    await markGateway(HERMES_PLUGIN_GENERATION)
    await writeFile(
      join(home, 'config.yaml'),
      'plugins:\n  enabled: [orca-status]\n  disabled: [orca-status]\n'
    )
    await expect(publish('bot', () => true, {})).rejects.toMatchObject({
      reason: 'botToolsNeedStatusHooks'
    })
    // A chat that is not a bot's starts either way, with no identity for its tools.
    await expect(publish('chat', () => true)).resolves.toBeTypeOf('function')
  })
})

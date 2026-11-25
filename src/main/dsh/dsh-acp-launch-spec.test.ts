import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { acpLaunchSpecFor } from '../acp/launch/acp-launch-registry'
import { acpLaunchInstructions } from '../acp/launch/acp-instructions'
import { DSH_LAUNCH_SPEC } from './dsh-acp-launch-spec'
import { discardDshListingSession } from './dsh-listing-session-discard'
import { isNativeChatAgent } from '../../shared/agent-launch/permissions/agent-chat-permission-support'
import { isBotAgent } from '../../shared/bot-types'
import { BOT_AGENTS_LISTING_LINKED_SKILLS } from '../../shared/bots/bot-skill-projects'
import { agentSessionSetupFor } from '../../shared/agent-session/lifecycle/launch/agent-session-setup-commands'

let tempDir = ''

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true })
    tempDir = ''
  }
})

describe('DSH ACP launch spec', () => {
  it('registers dsh as a native chat and bot agent', () => {
    expect(acpLaunchSpecFor('dsh')).toBe(DSH_LAUNCH_SPEC)
    expect(isNativeChatAgent('dsh')).toBe(true)
    expect(isBotAgent('dsh')).toBe(true)
    expect(BOT_AGENTS_LISTING_LINKED_SKILLS).toContain('dsh')
    expect(agentSessionSetupFor('dsh')?.loginCommand).toEqual(['dsh-tui'])
  })

  it('launches dsh with the acp profile and pins DSH_HOME', async () => {
    expect(DSH_LAUNCH_SPEC.command).toBe('dsh')
    expect(DSH_LAUNCH_SPEC.ignoreAgentCommandSetting).toBe(true)
    expect(DSH_LAUNCH_SPEC.args({ fullAccess: false, pluginDirs: [] })).toEqual(['--profile', 'acp'])
    expect(DSH_LAUNCH_SPEC.keepsEverySession).toBe(true)

    const resolved = await DSH_LAUNCH_SPEC.account.resolve({
      launchEnv: { HOME: '/tmp/user-home', DSH_HOME: '/tmp/custom-dsh' },
      stateDirectory: '/tmp/state'
    })
    expect(resolved).toEqual({ variable: 'DSH_HOME', path: '/tmp/custom-dsh' })
  })

  it('writes standing instructions to AGENTS.local.md and removes them when a launch has none', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'dsh-instructions-'))
    const result = await acpLaunchInstructions(DSH_LAUNCH_SPEC, tempDir, {
      sessionId: 'dsh-session-1',
      text: 'Follow Orca bot rules.',
      env: {},
      cwd: tempDir
    })
    expect(result).toEqual({})
    const instructionsPath = join(tempDir, 'AGENTS.local.md')
    const content = await readFile(instructionsPath, 'utf8')
    expect(content).toContain('Follow Orca bot rules.')

    // A subsequent launch without instructions removes Orca's file so old rules do not linger.
    await expect(
      acpLaunchInstructions(DSH_LAUNCH_SPEC, tempDir, {
        sessionId: 'dsh-session-2',
        text: null,
        env: {},
        cwd: tempDir
      })
    ).resolves.toBeNull()
    await expect(stat(instructionsPath)).rejects.toThrow()

    // User-authored text in AGENTS.local.md is preserved when Orca's block is removed.
    await writeFile(instructionsPath, 'User rules.\n')
    await acpLaunchInstructions(DSH_LAUNCH_SPEC, tempDir, {
      sessionId: 'dsh-session-3',
      text: 'Bot rules.',
      env: {},
      cwd: tempDir
    })
    expect(await readFile(instructionsPath, 'utf8')).toContain('Bot rules.')
    await acpLaunchInstructions(DSH_LAUNCH_SPEC, tempDir, {
      sessionId: 'dsh-session-4',
      text: null,
      env: {},
      cwd: tempDir
    })
    expect(await readFile(instructionsPath, 'utf8')).toBe('User rules.\n')
  })

  it('discards temporary model-listing sessions without touching sibling sessions', async () => {
    expect(DSH_LAUNCH_SPEC.modelDiscovery).toEqual({
      kind: 'session',
      listingNamesConfiguredModel: false,
      inPrivateFolder: true,
      listsOnDemand: true,
      discardSession: discardDshListingSession
    })

    tempDir = await mkdtemp(join(tmpdir(), 'dsh-discard-'))
    const listingId = '11111111-2222-4333-8444-555555555555'
    const keptId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    const onlyListingProject = join(tempDir, 'sessions', '--private-folder--')
    const sharedProject = join(tempDir, 'sessions', '--shared-folder--')
    const unrelatedEmptyProject = join(tempDir, 'sessions', '--unrelated-empty--')

    await mkdir(join(onlyListingProject, listingId), { recursive: true })
    await writeFile(join(onlyListingProject, listingId, 'v4.jsonl'), '{}')
    await mkdir(join(sharedProject, keptId), { recursive: true })
    await writeFile(join(sharedProject, keptId, 'v4.jsonl'), '{}')
    await mkdir(unrelatedEmptyProject, { recursive: true })

    await discardDshListingSession({
      sessionId: listingId,
      cwd: tempDir,
      accountHomePath: tempDir,
      runAgent: async () => ''
    })

    await expect(stat(onlyListingProject)).rejects.toThrow()
    await expect(stat(join(sharedProject, keptId, 'v4.jsonl'))).resolves.toBeDefined()
    await expect(stat(unrelatedEmptyProject)).resolves.toBeDefined()

    // Non-UUID session IDs are ignored safely without touching directories.
    await discardDshListingSession({
      sessionId: '../escape',
      cwd: tempDir,
      accountHomePath: tempDir,
      runAgent: async () => ''
    })
    await expect(stat(join(sharedProject, keptId, 'v4.jsonl'))).resolves.toBeDefined()
  })
})

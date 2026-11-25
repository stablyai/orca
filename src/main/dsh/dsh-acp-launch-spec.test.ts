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

  it('writes standing instructions around session/new and removes them on undo or instruction-free launch', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'dsh-instructions-'))
    const result = await acpLaunchInstructions(DSH_LAUNCH_SPEC, tempDir, {
      sessionId: 'dsh-session-1',
      text: 'Follow Orca bot rules.',
      env: {},
      cwd: tempDir
    })
    expect(result?.aroundNewSession).toBeTypeOf('function')
    const instructionsPath = join(tempDir, 'AGENTS.local.md')
    await expect(stat(instructionsPath)).rejects.toThrow()

    const undo = await result?.aroundNewSession?.(tempDir)
    expect(await readFile(instructionsPath, 'utf8')).toContain('Follow Orca bot rules.')

    // A concurrent instruction-free launch waits until session/new finishes and calls undo.
    let undoCompleted = false
    const concurrentNoInstructions = acpLaunchInstructions(DSH_LAUNCH_SPEC, tempDir, {
      sessionId: 'dsh-session-2',
      text: null,
      env: {},
      cwd: tempDir
    }).then((res) => {
      undoCompleted = true
      return res
    })

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(undoCompleted).toBe(false)
    expect(await readFile(instructionsPath, 'utf8')).toContain('Follow Orca bot rules.')

    await undo?.()
    await expect(concurrentNoInstructions).resolves.toBeNull()
    expect(undoCompleted).toBe(true)
    await expect(stat(instructionsPath)).rejects.toThrow()

    // Two concurrent launches with instructions serialize around session/new in the same folder.
    const firstLaunch = await acpLaunchInstructions(DSH_LAUNCH_SPEC, tempDir, {
      sessionId: 'dsh-session-3a',
      text: 'First bot rules.',
      env: {},
      cwd: tempDir
    })
    const firstUndo = await firstLaunch?.aroundNewSession?.(tempDir)
    expect(await readFile(instructionsPath, 'utf8')).toContain('First bot rules.')

    const secondLaunch = await acpLaunchInstructions(DSH_LAUNCH_SPEC, tempDir, {
      sessionId: 'dsh-session-3b',
      text: 'Second bot rules.',
      env: {},
      cwd: tempDir
    })
    let secondPlaced = false
    const secondPlacement = secondLaunch?.aroundNewSession?.(tempDir).then((nextUndo) => {
      secondPlaced = true
      return nextUndo
    })

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(secondPlaced).toBe(false)
    expect(await readFile(instructionsPath, 'utf8')).toContain('First bot rules.')

    await firstUndo?.()
    const secondUndo = await secondPlacement
    expect(secondPlaced).toBe(true)
    expect(await readFile(instructionsPath, 'utf8')).toContain('Second bot rules.')
    await secondUndo?.()
    await expect(stat(instructionsPath)).rejects.toThrow()

    // User-authored text in AGENTS.local.md is preserved when Orca's block is removed.
    await writeFile(instructionsPath, 'User rules.\n')
    const userPreservingLaunch = await acpLaunchInstructions(DSH_LAUNCH_SPEC, tempDir, {
      sessionId: 'dsh-session-4',
      text: 'Bot rules.',
      env: {},
      cwd: tempDir
    })
    const userUndo = await userPreservingLaunch?.aroundNewSession?.(tempDir)
    expect(await readFile(instructionsPath, 'utf8')).toContain('Bot rules.')
    await userUndo?.()
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

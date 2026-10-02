import { EventEmitter } from 'node:events'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createLinkedRootHome,
  linkOrcaPlacement,
  linkProviderRoot,
  removeLinkedRootHomes,
  writeRealSkillDirectory
} from '../../shared/skill-linked-root-deletion.test-fixture'
import { SkillUpdateRunner } from './skill-update-run'

const originalHome = process.env.HOME
const originalUserProfile = process.env.USERPROFILE

afterEach(async () => {
  process.env.HOME = originalHome
  process.env.USERPROFILE = originalUserProfile
  vi.restoreAllMocks()
  await removeLinkedRootHomes()
})

class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  pid: number | undefined = 1234
  kill = vi.fn()
}

/**
 * The runner with its real pre-flight guard, reading a scratch HOME. Nothing is injected
 * here on purpose: the point is that the default path refuses the destructive case.
 */
function guardedRunner(home: string) {
  process.env.HOME = home
  process.env.USERPROFILE = home
  const spawnCalls: { args: string[] }[] = []
  const runner = new SkillUpdateRunner({
    now: () => 1000,
    resolveCommand: () => '/usr/local/bin/npx',
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: `typeof spawn` is a five-overload signature the runner only ever calls one way (command, argv, options), and the fake records exactly that call; nothing here reads a ChildProcess member the emitter lacks.
    spawnProcess: ((_command: string, args: string[]) => {
      spawnCalls.push({ args })
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the runner only attaches stdout/stderr/close/error handlers and reads `pid`, all of which FakeChild provides.
      return new FakeChild() as never
    }) as never
  })
  return { runner, spawnCalls }
}

/** One name at risk (a real directory) and one that is not (the link Orca placed). */
async function mixedLinkedRootHome(): Promise<string> {
  const home = await createLinkedRootHome()
  await linkProviderRoot(home, '.claude')
  await writeRealSkillDirectory(join(home, 'dotfiles', 'skills'), 'orca-cli')
  await linkOrcaPlacement(home, 'orchestration')
  return home
}

// Runs on Windows too: the fixture links with the junction production writes there.
describe('SkillUpdateRunner pre-flight guard', () => {
  it('keeps a name whose destination is a real directory out of the argv', async () => {
    const home = await mixedLinkedRootHome()
    const { runner, spawnCalls } = guardedRunner(home)
    // The guard reads the process's own home, so prove the scratch one is in force.
    expect(homedir()).toBe(home)

    expect(await runner.start(['orca-cli', 'orchestration'])).toEqual({ started: true })
    expect(spawnCalls[0].args).toEqual([
      '--yes',
      'skills',
      'update',
      'orchestration',
      '--global',
      '-y'
    ])
    expect(spawnCalls[0].args).not.toContain('orca-cli')
  })

  it('seeds the run log with the reason instead of dropping the name silently', async () => {
    const home = await mixedLinkedRootHome()
    const { runner } = guardedRunner(home)

    await runner.start(['orca-cli', 'orchestration'])

    const run = runner.getState()
    expect(run.state).toBe('running')
    expect(run.state === 'running' ? run.output : '').toContain('Skipped orca-cli')
  })

  it('refuses to spawn at all when every requested name is at risk', async () => {
    const home = await createLinkedRootHome()
    await linkProviderRoot(home, '.claude')
    await writeRealSkillDirectory(join(home, 'dotfiles', 'skills'), 'orca-cli')
    const { runner, spawnCalls } = guardedRunner(home)

    expect(await runner.start(['orca-cli'])).toEqual({
      started: false,
      reason: 'all-names-skipped'
    })
    expect(spawnCalls).toHaveLength(0)
    expect(runner.getState()).toEqual({ state: 'idle' })
  })

  it('still spawns every name when no root is a link', async () => {
    const home = await createLinkedRootHome()
    await writeRealSkillDirectory(join(home, '.claude', 'skills'), 'orca-cli')
    const { runner, spawnCalls } = guardedRunner(home)

    expect(await runner.start(['orca-cli'])).toEqual({ started: true })
    expect(spawnCalls[0].args).toContain('orca-cli')
  })
})

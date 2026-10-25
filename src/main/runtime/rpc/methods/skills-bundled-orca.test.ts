import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  BundledSkillInstallResult,
  BundledSkillPlan,
  BundledSkillPlanRequest
} from '../../../../shared/bundled-skill-plan'
import {
  installBundledSkills,
  previewBundledSkillInstall
} from '../../../skills/bundled-skill-install/service'
import {
  makeSkillHome,
  NAME,
  NEW_TEXT,
  OLD_TEXT,
  removeSkillHomes,
  serviceInput,
  writeCopy,
  type SkillHome
} from '../../../skills/bundled-skill-install/skill-home.test-support'
import { eraseRpcMethods, type RpcContext } from '../core'

vi.mock('electron', () => ({
  app: { getPath: () => '/orca-state', isPackaged: true }
}))

const { SKILL_METHODS } = await import('./skills')

function method(name: string) {
  const value = eraseRpcMethods(SKILL_METHODS).find((entry) => entry.name === name)
  if (!value) {
    throw new Error(`${name} method not registered`)
  }
  return value
}

/** Calls a method as the dispatcher does: parse the wire params, then run the handler. */
async function call<T>(name: string, params: unknown, context: RpcContext): Promise<T> {
  const entry = method(name)
  const parsed = entry.params ? entry.params.parse(params) : undefined
  const result = await entry.handler(parsed, context)
  // Why JSON: the result crosses the wire, so the client only ever sees its serialised form.
  const wire: T = JSON.parse(JSON.stringify(result))
  return wire
}

/** The host's runtime, planning its own (temp) home as `planLocalBundledSkills` does. */
function hostContext(home: SkillHome): RpcContext {
  const input = (request: BundledSkillPlanRequest) => ({
    ...serviceInput(home, {
      installedOnly: !request.names,
      ...(request.force ? { force: request.force } : {})
    }),
    ...(request.names ? { names: request.names } : {})
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these handlers read only the two runtime methods stubbed here.
  return {
    runtime: {
      planLocalBundledSkills: (request: BundledSkillPlanRequest) =>
        previewBundledSkillInstall(input(request)),
      executeLocalBundledSkills: ({
        planDigest,
        request
      }: {
        planDigest: string
        request: BundledSkillPlanRequest
      }) => installBundledSkills(input(request), planDigest)
    }
  } as unknown as RpcContext
}

afterEach(async () => {
  await removeSkillHomes()
})

describe('skills.planBundledOrca / skills.executeBundledOrca', () => {
  it('plans read-only and executes behind skills-admin', () => {
    expect(method('skills.planBundledOrca').permission).toBe('workspace')
    expect(method('skills.executeBundledOrca').permission).toBe('skills-admin')
  })

  it('never lets a paired client point the host at a WSL guest or send ops', () => {
    const plan = method('skills.planBundledOrca').params
    const execute = method('skills.executeBundledOrca').params
    expect(() => plan?.parse({ wsl: { distro: 'Ubuntu' } })).toThrow()
    expect(() => execute?.parse({ planDigest: 'a'.repeat(64), request: {}, ops: [] })).toThrow()
    expect(() => execute?.parse({ planDigest: 'a'.repeat(64), force: [] })).toThrow()
    expect(execute?.parse({ planDigest: 'a'.repeat(64), request: { force: ['/x'] } })).toEqual({
      planDigest: 'a'.repeat(64),
      request: { force: ['/x'] }
    })
  })

  it('executes the plan the client previewed, identified by its digest', async () => {
    const home = await makeSkillHome()
    await writeCopy(home.claude, OLD_TEXT)
    const context = hostContext(home)

    const plan = await call<BundledSkillPlan>('skills.planBundledOrca', {}, context)
    expect(plan.skills[0].ops.map((op) => [op.path, op.kind])).toEqual([[home.claude, 'update']])
    const result = await call<BundledSkillInstallResult>(
      'skills.executeBundledOrca',
      { planDigest: plan.planDigest, request: {} },
      context
    )

    expect(result.skills[0]).toMatchObject({
      status: 'ran',
      ops: [{ path: home.claude, kind: 'update', status: 'done' }]
    })
    expect(await readFile(join(home.claude, 'SKILL.md'), 'utf8')).toBe(NEW_TEXT)
  })

  it('writes nothing when the disk changed after the preview', async () => {
    const home = await makeSkillHome()
    await writeCopy(home.claude, OLD_TEXT)
    const context = hostContext(home)
    const plan = await call<BundledSkillPlan>('skills.planBundledOrca', {}, context)

    await writeFile(join(home.claude, 'SKILL.md'), 'edited meanwhile\n')
    const result = await call<BundledSkillInstallResult>(
      'skills.executeBundledOrca',
      { planDigest: plan.planDigest, request: {} },
      context
    )

    expect(result.skills.map((skill) => skill.status)).toEqual(['changed'])
    expect(await readFile(join(home.claude, 'SKILL.md'), 'utf8')).toBe('edited meanwhile\n')
  })

  it('installs named skills for the host’s agents, as `orca skills install` does', async () => {
    const home = await makeSkillHome()
    const context = hostContext(home)
    const request = { names: [NAME] }

    const plan = await call<BundledSkillPlan>('skills.planBundledOrca', request, context)
    expect(plan.skills[0].ops.map((op) => [op.path, op.kind])).toEqual([
      [home.shared, 'write'],
      [home.claude, 'link']
    ])
    const result = await call<BundledSkillInstallResult>(
      'skills.executeBundledOrca',
      { planDigest: plan.planDigest, request },
      context
    )

    expect(result.skills[0].ops.map((op) => op.status)).toEqual(['done', 'done'])
    expect(await readFile(join(home.claude, 'SKILL.md'), 'utf8')).toBe(NEW_TEXT)
  })

  it('rejects a name the host does not ship', async () => {
    const home = await makeSkillHome()
    await expect(
      call('skills.planBundledOrca', { names: ['not-an-orca-skill'] }, hostContext(home))
    ).rejects.toThrow('bundled-skill-unknown')
    expect(() => method('skills.planBundledOrca').params?.parse({ names: ['../x'] })).toThrow()
  })

  it('runs nothing when the executed request names different skills than the preview', async () => {
    const home = await makeSkillHome()
    const context = hostContext(home)
    const plan = await call<BundledSkillPlan>('skills.planBundledOrca', { names: [NAME] }, context)

    const result = await call<BundledSkillInstallResult>(
      'skills.executeBundledOrca',
      { planDigest: plan.planDigest, request: {} },
      context
    )

    expect(result.skills.map((skill) => skill.status)).toEqual(['changed'])
    expect(await readFile(join(home.shared, 'SKILL.md'), 'utf8').catch(() => null)).toBeNull()
  })
})

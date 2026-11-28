import { beforeEach, describe, expect, it, vi } from 'vitest'
import { COMMAND_SPECS } from '../specs/index'
import { normalizeCommandPositionals, parseArgs } from '../arguments/args'
import { specPaths } from '../discovery/command-spec'
import type { HandlerContext } from '../dispatch/dispatch'
import type { RuntimeClient } from '../runtime/client'
import type { Automation, AutomationPrecheck } from '../../shared/automations/automation-definition'
import { AUTOMATION_HANDLERS } from './automations'

const PRECHECK: AutomationPrecheck = { command: 'gh pr list', timeoutSeconds: 120 }

function savedAutomation(precheck: AutomationPrecheck | null): Automation {
  return {
    id: 'auto_1',
    name: 'Nightly',
    prompt: 'Tidy the repo',
    precheck,
    agentId: 'claude',
    projectId: 'acme/notes',
    executionTargetType: 'local',
    executionTargetId: 'local',
    schedulerOwner: 'local_host_service',
    workspaceMode: 'new_per_run',
    workspaceId: null,
    baseBranch: null,
    reuseSession: false,
    timezone: 'UTC',
    rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
    dtstart: 0,
    enabled: true,
    nextRunAt: 0,
    missedRunPolicy: 'run_once_within_grace',
    missedRunGraceMinutes: 0,
    createdAt: 0,
    updatedAt: 0
  }
}

function parseFlags(argv: string[]): HandlerContext['flags'] {
  const paths = COMMAND_SPECS.flatMap((spec) => specPaths(spec))
  return normalizeCommandPositionals(COMMAND_SPECS, parseArgs(argv, paths, COMMAND_SPECS)).flags
}

type EditResult = { calls: string[]; updates: Record<string, unknown> | undefined }

async function edit(argv: string[], current: Automation, result: EditResult): Promise<void> {
  const call = vi.fn(async (method: string, payload: { updates?: Record<string, unknown> }) => {
    result.calls.push(method)
    if (method === 'automation.show') {
      return { result: { automation: current, owner: null } }
    }
    if (method === 'automation.update') {
      result.updates = payload.updates
      return { result: { automation: current } }
    }
    return { result: {} }
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the edit handler only calls client.call and reads isRemote.
  const client = { call, isRemote: false } as unknown as RuntimeClient
  const ctx: HandlerContext = {
    flags: parseFlags(argv),
    client,
    cwd: '/tmp',
    json: true,
    rawArgs: argv
  }
  await AUTOMATION_HANDLERS['automations edit'](ctx)
}

function newResult(): EditResult {
  return { calls: [], updates: undefined }
}

describe('automations edit --precheck', () => {
  beforeEach(() => {
    vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  })

  it('keeps the saved timeout when the edit repeats only the command', async () => {
    const result = newResult()
    await edit(
      ['automations', 'edit', 'auto_1', '--precheck', 'gh pr list'],
      savedAutomation(PRECHECK),
      result
    )
    expect(result.updates?.precheck).toEqual({
      command: 'gh pr list',
      timeoutSeconds: 120
    })
  })

  it('retimes the saved command when only --precheck-timeout is passed', async () => {
    const result = newResult()
    await edit(
      ['automations', 'edit', 'auto_1', '--precheck-timeout', '300'],
      savedAutomation(PRECHECK),
      result
    )
    expect(result.updates?.precheck).toEqual({
      command: 'gh pr list',
      timeoutSeconds: 300
    })
  })

  it('leaves the precheck untouched when neither flag is passed', async () => {
    const result = newResult()
    await edit(
      ['automations', 'edit', 'auto_1', '--name', 'Nightly'],
      savedAutomation(PRECHECK),
      result
    )
    expect(result.updates).toBeDefined()
    expect(result.updates).not.toHaveProperty('precheck')
  })

  it('uses the default timeout only for a command that had none saved', async () => {
    const result = newResult()
    await edit(
      ['automations', 'edit', 'auto_1', '--precheck', 'gh pr list'],
      savedAutomation(null),
      result
    )
    expect(result.updates?.precheck).toEqual({ command: 'gh pr list', timeoutSeconds: 60 })
  })

  it('still clears the precheck when the command is empty', async () => {
    const result = newResult()
    await edit(
      ['automations', 'edit', 'auto_1', '--precheck', ''],
      savedAutomation(PRECHECK),
      result
    )
    expect(result.updates?.precheck).toBeNull()
  })

  it('refuses --precheck-timeout alone when no precheck is saved', async () => {
    await expect(
      edit(
        ['automations', 'edit', 'auto_1', '--precheck-timeout', '300'],
        savedAutomation(null),
        newResult()
      )
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message: expect.stringMatching(/--precheck-timeout requires --precheck/)
    })
  })

  it.each([
    [['--precheck'], '--precheck requires a command'],
    [['--precheck', 'gh pr list', '--precheck-timeout', '601'], 'at most 600 seconds']
  ])('rejects malformed precheck flags %j before reading the automation', async (args, message) => {
    const result = newResult()
    await expect(
      edit(['automations', 'edit', 'auto_1', ...args], savedAutomation(PRECHECK), result)
    ).rejects.toMatchObject({ code: 'invalid_argument', message: expect.stringContaining(message) })
    expect(result.calls).toEqual([])
  })
})

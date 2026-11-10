// Human output of `orca cloud …` follows the product glossary: states, errors and sizes in words,
// raw API codes only under --json.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HandlerContext } from '../dispatch'
import { cloudApiError } from './cloud-api-errors'
import { nodeCloudCredentialFs } from './cloud-credentials'
import {
  cloudWorkspaceStateLabel,
  formatCloudWorkspace,
  formatCloudWorkspaceList,
  type CloudWorkspace
} from './cloud-format'
import { createCloudHandlers, type CloudHandlerDeps } from './cloud-handlers'
import { formatRoutineList, routineRunErrorCopy } from './cloud-routines'
import type { Routine } from '../../shared/cloud-api/cloud-api-routine-types'

const NOW = 10_000_000

function workspace(overrides: Partial<CloudWorkspace> = {}): CloudWorkspace {
  return {
    id: 'sbx_aa11',
    name: 'child',
    projectId: null,
    status: 'running',
    archived: false,
    hidden: false,
    origin: 'vm',
    machineSize: 'standard',
    region: 'iad1',
    repoUrl: null,
    session: null,
    lastError: null,
    createdAt: NOW - 3_600_000,
    updatedAt: NOW - 60_000,
    ...overrides
  }
}

const user = { source: 'env' as const, token: 'orca_sk_x', path: null }

let logs: string[]
beforeEach(() => {
  logs = []
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => void logs.push(String(line)))
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})
afterEach(() => {
  vi.restoreAllMocks()
})

function deps(routes: Record<string, () => [number, unknown]>): {
  deps: CloudHandlerDeps
  calls: string[]
} {
  const calls: string[] = []
  let clock = NOW
  const fetchImpl = vi.fn(async (input: string, init: RequestInit) => {
    const key = `${init.method ?? 'GET'} ${new URL(input).pathname}`
    calls.push(key)
    const route = routes[key]
    const [status, body] = route ? route() : [404, { error: 'not_found' }]
    return Response.json(body, { status })
  })
  return {
    calls,
    deps: {
      env: { ORCA_CLOUD_TOKEN: 'orca_sk_test', ORCA_CLOUD_API_URL: 'https://cloud.test' },
      fetch: fetchImpl,
      fs: nodeCloudCredentialFs,
      home: '/nonexistent',
      now: () => clock,
      sleep: async (ms) => {
        clock += ms
      },
      readStdin: async () => null
    }
  }
}

function ctx(flags: Record<string, string | boolean>, json = false): HandlerContext {
  return {
    flags: new Map(Object.entries(flags)),
    get client(): never {
      throw new Error('cloud commands must not use the runtime client')
    },
    cwd: '/',
    json
  }
}

describe('workspace states and output', () => {
  it('maps every API status to the glossary', () => {
    const label = (status: string, archived = false) =>
      cloudWorkspaceStateLabel({ status, archived })
    expect(label('starting')).toBe('Starting')
    expect(label('running')).toBe('Running')
    expect(label('sleeping')).toBe('Asleep')
    expect(label('sleeping', true)).toBe('Archived')
    expect(label('waking')).toBe('Waking')
    expect(label('failed')).toBe("Couldn't start")
    expect(label('destroying')).toBe('Deleting')
  })

  it('lists ID NAME STATE REPO BRANCH LAST ACTIVE, falling back to updatedAt', () => {
    const text = formatCloudWorkspaceList(
      {
        workspaces: [
          workspace({ repoUrl: 'https://github.com/acme/app', repoBranch: 'fix-login' }),
          workspace({ id: 'sbx_bb22', name: 'old', status: 'failed', lastError: 'create_failed' })
        ]
      },
      NOW
    )
    expect(text.split('\n')).toEqual([
      'ID        NAME   STATE           REPO      BRANCH     LAST ACTIVE',
      'sbx_aa11  child  Running         acme/app  fix-login  1m ago',
      "sbx_bb22  old    Couldn't start  -         -          1m ago"
    ])
  })

  it('shows the sandbox size from ORCA_CLOUD_SANDBOX_SPEC and no VM, size or raw codes', () => {
    const text = formatCloudWorkspace(
      { workspace: workspace({ status: 'sleeping', lastError: 'resume_failed' }) },
      NOW
    )
    expect(text).toContain('State: Asleep')
    expect(text).toContain('Sandbox size: 8 vCPU · 16 GB')
    expect(text).toContain(
      "The last wake didn't finish. Your files are safe. Run: orca cloud workspace wake sbx_aa11"
    )
    expect(text).toContain('Created from: another cloud workspace')
    expect(text).not.toMatch(/resume_failed|sleeping|standard|\bVM\b|\bvm\b|iad1/)
  })
})

describe('glossary error copy', () => {
  it('splits out-of-hours from the spend cap and never says "files are safe" on create', () => {
    const hours = cloudApiError(
      403,
      { error: 'entitlement_denied', reason: 'included_hours_exhausted' },
      { credentials: user, intent: 'create' }
    )
    expect(hours.code).toBe('cloud_out_of_hours')
    expect(hours.message).toBe(
      "Your team is out of sandbox hours. Nothing was created, and you weren't charged."
    )
    expect(hours.data).toMatchObject({ nextSteps: ['Ask an owner or admin to add hours.'] })
    const cap = cloudApiError(
      403,
      { error: 'entitlement_denied', reason: 'overage_cap_reached' },
      { credentials: user, intent: 'create' }
    )
    expect(cap.code).toBe('cloud_spend_cap_reached')
    expect(cap.data).toMatchObject({
      nextSteps: ['Ask an owner or admin to raise the spend cap.']
    })
    // Waking an existing workspace keeps its files.
    expect(
      cloudApiError(
        403,
        { error: 'entitlement_denied', reason: 'included_hours_exhausted' },
        { credentials: user }
      ).message
    ).toBe('Your team is out of sandbox hours. Your files are safe.')
  })

  it('uses the exact 409, admin and rate-limit copy, with codes kept in data', () => {
    const busy = cloudApiError(
      409,
      { error: 'conflict', reason: 'sandbox_suspending' },
      { credentials: user }
    )
    expect(busy.message).toBe(
      'This workspace is still starting or going to sleep. Nothing was changed. Try again in a moment.'
    )
    expect(busy.data).toMatchObject({ apiError: 'conflict', reason: 'sandbox_suspending' })
    expect(
      cloudApiError(
        403,
        { error: 'forbidden', reason: 'org_admin_required' },
        { credentials: user }
      ).message
    ).toBe('Only a team owner or admin can do this.')
    expect(
      cloudApiError(429, { error: 'rate_limited' }, { credentials: user, retryAfter: '1' }).data
    ).toMatchObject({ nextSteps: ['Try again in 1 second.'] })
    expect(
      cloudApiError(
        400,
        { error: 'invalid_request', reason: 'name: Too big' },
        { credentials: user }
      ).message
    ).toBe("Orca Cloud didn't accept the value for name. Nothing was changed.")
    expect(
      cloudApiError(502, { error: 'provider_unavailable' }, { credentials: user }).message
    ).not.toContain('provider_unavailable')
  })

  it('turns a failed wake (resume_failed) into the glossary copy', async () => {
    const { deps: d } = deps({
      'POST /v1/workspaces/sbx_aa11/wake': () => [
        200,
        {
          workspace: workspace({ status: 'sleeping', lastError: 'resume_failed' }),
          state: 'failed'
        }
      ]
    })
    await expect(
      createCloudHandlers(() => d)['cloud workspace wake'](
        ctx({ workspace: 'sbx_aa11', progress: 'none' })
      )
    ).rejects.toMatchObject({
      code: 'cloud_wake_failed',
      message:
        "The last wake didn't finish. Your files are safe. Run: orca cloud workspace wake sbx_aa11"
    })
  })
})

describe('orca cloud routine', () => {
  const routine: Routine = {
    id: 'rtn_a1',
    name: 'Nightly triage',
    projectId: null,
    repo: null,
    enabled: true,
    trigger: { kind: 'schedule', cron: '0 9 * * 1-5', timezone: 'America/New_York' },
    agent: 'claude',
    prompt: 'x',
    postResults: 'none',
    maxRuntimeMinutes: 30,
    nextRunAt: null,
    lastRun: { id: 'run_1', status: 'cancelled', finishedAt: NOW - 7_200_000 },
    createdBy: 'u',
    createdByName: null,
    createdAt: 1,
    updatedAt: 1
  }

  it('lists routines with the trigger and last run in words', () => {
    const text = formatRoutineList(
      {
        routines: [
          routine,
          {
            ...routine,
            id: 'rtn_b2',
            name: 'PR review',
            enabled: false,
            lastRun: null,
            trigger: { kind: 'webhook', urlHint: null }
          }
        ]
      },
      NOW
    )
    expect(text).toContain('ID      NAME')
    expect(text).toMatch(
      /rtn_a1 +Nightly triage +Weekdays at 9:00 AM \(America\/New_York\) +Canceled 2h ago/
    )
    expect(text).toMatch(/rtn_b2 +PR review \(paused\) +Webhook +Never run/)
    expect(text).not.toContain('cancelled')
  })

  it('queues a run by id without --wait and points at --wait', async () => {
    const { deps: d, calls } = deps({
      'GET /v1/routines/rtn_a1': () => [200, { routine }],
      'POST /v1/routines/rtn_a1/run': () => [
        202,
        { run: { id: 'run_9', status: 'queued', result: null, durationMs: null, error: null } }
      ]
    })
    await createCloudHandlers(() => d)['cloud routine run'](ctx({ routine: 'rtn_a1' }))
    expect(calls).toEqual(['GET /v1/routines/rtn_a1', 'POST /v1/routines/rtn_a1/run'])
    expect(logs.at(-1)).toBe(
      'Nightly triage: Queued (run_9)\nAdd --wait to follow a run until it finishes.'
    )
  })

  it('--wait fails with the run error in words and keeps the code in data', async () => {
    const failed = {
      id: 'run_9',
      status: 'failed',
      error: 'start_failed:provider_unavailable',
      result: null,
      durationMs: null
    }
    const { deps: d } = deps({
      'GET /v1/routines': () => [200, { routines: [routine] }],
      'POST /v1/routines/rtn_a1/run': () => [202, { run: { ...failed, status: 'queued' } }],
      'GET /v1/routines/rtn_a1/runs/run_9': () => [200, { run: failed }]
    })
    await expect(
      createCloudHandlers(() => d)['cloud routine run'](
        ctx({ routine: 'Nightly triage', wait: true, progress: 'none' })
      )
    ).rejects.toMatchObject({
      code: 'cloud_routine_run_failed',
      message: "The workspace couldn't start. Nothing was charged.",
      data: { run: { error: 'start_failed:provider_unavailable' } }
    })
  })

  it('refuses --timeout without --wait and unknown names before running anything', async () => {
    const { deps: d, calls } = deps({ 'GET /v1/routines': () => [200, { routines: [routine] }] })
    const handlers = createCloudHandlers(() => d)
    await expect(
      handlers['cloud routine run'](ctx({ routine: 'rtn_a1', timeout: '5' }))
    ).rejects.toThrow('--timeout needs --wait.')
    await expect(handlers['cloud routine run'](ctx({ routine: 'nope' }))).rejects.toMatchObject({
      code: 'cloud_not_found'
    })
    expect(calls).toEqual(['GET /v1/routines'])
  })

  it('maps run errors to plain sentences', () => {
    expect(routineRunErrorCopy('workspace_lost:suspended')).toBe(
      'The workspace went to sleep or was deleted before the run finished.'
    )
    expect(routineRunErrorCopy('running_interrupted')).toBe('Orca Cloud restarted during the run.')
    expect(routineRunErrorCopy('queue_expired')).toBe(
      'The run waited too long to start and was skipped.'
    )
    expect(routineRunErrorCopy('weird')).toBe('The run failed.')
  })
})

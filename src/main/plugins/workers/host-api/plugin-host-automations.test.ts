import { describe, expect, it, vi } from 'vitest'
import type { PluginRuntimeRpc } from './plugin-host-runtime-call'
import type { PluginHostServices } from './plugin-host-method-bindings'
import { callPluginHost, pluginHostTestServices } from './__mocks__/plugin-host-services-fixture'

const AUTOMATION = {
  id: 'a1',
  name: 'Nightly sweep',
  prompt: 'p'.repeat(5000),
  agentId: 'claude',
  projectId: 'r1',
  runContext: { repoId: 'r1', hostId: 'local', projectId: 'p1', path: '/src/r1' },
  workspaceMode: 'existing',
  workspaceId: 'r1::/src/r1',
  rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
  timezone: 'UTC',
  enabled: true,
  nextRunAt: 10,
  precheck: { command: 'secret-check', timeoutSeconds: 30 },
  extraAgentArgs: '--dangerously-skip-permissions'
}
const OWN = {
  ...AUTOMATION,
  id: 'a2',
  createdBy: { kind: 'plugin', pluginKey: 'samples.demo', name: 'Demo' }
}

const OWN_ELEVATED = { ...OWN, id: 'a3', launchPreferences: { permissionMode: 'bypass' } }
const ENDED = {
  ...AUTOMATION,
  id: 'a4',
  createdBy: { kind: 'plugin', pluginKey: 'samples.demo', name: 'Demo', endedAt: 5 }
}
const BY_ID: Record<string, unknown> = { a2: OWN, a3: OWN_ELEVATED, a4: ENDED }

function runtime() {
  const answers: Record<string, unknown> = {
    'repo.list': { repos: [{ id: 'r1', executionHostId: 'local' }] },
    'automation.list': { automations: [AUTOMATION, OWN, ENDED] },
    'worktree.list': { worktrees: [{ id: 'r1::/src/r1', identity: { key: 'wt2:local:i1' } }] },
    'automation.create': { automation: { id: 'new' } },
    'automation.update': { automation: AUTOMATION },
    'automation.delete': { removed: true, id: 'a1' }
  }
  return vi.fn<PluginRuntimeRpc>(async (method, params) => {
    if (method === 'automation.show') {
      const id = typeof params === 'object' && params !== null && 'id' in params ? params.id : ''
      return { automation: BY_ID[String(id)] ?? AUTOMATION }
    }
    return answers[method]
  })
}
const methods = (rpc: ReturnType<typeof runtime>) => rpc.mock.calls.map(([method]) => method)

const call = (
  method: string,
  params: unknown,
  rpc: PluginRuntimeRpc,
  overrides: Partial<PluginHostServices> = {}
) =>
  callPluginHost({
    method,
    params,
    granted: ['automation:read', 'automation:write'],
    services: pluginHostTestServices(rpc, overrides)
  })

describe('automation.list', () => {
  it('shows what an automation does, never its precheck or agent arguments', async () => {
    const outcome = await call('automation.list', {}, runtime())
    expect(outcome.ok && outcome.value).toEqual({
      automations: [
        {
          id: 'a1',
          name: 'Nightly sweep',
          agent: 'claude',
          prompt: 'p'.repeat(4096),
          promptTruncated: true,
          projectId: 'r1',
          hostId: 'local',
          workspaceId: 'identity:wt2:local:i1',
          workspaceMode: 'existing',
          schedule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
          timezone: 'UTC',
          enabled: true,
          nextRunAt: 10,
          lastRunAt: null,
          createdByThisPlugin: false
        },
        expect.objectContaining({ id: 'a2', createdByThisPlugin: true }),
        // Its plugin was removed or disabled since: the plugin no longer owns it.
        expect.objectContaining({ id: 'a4', createdByThisPlugin: false })
      ],
      truncated: false
    })
  })
})

describe('automation.create', () => {
  it('forwards only what a plugin may set, and names the plugin as its creator', async () => {
    const rpc = runtime()
    expect(
      await call(
        'automation.create',
        {
          name: 'Deps',
          prompt: 'Check dependencies',
          agent: 'codex',
          projectId: 'r1',
          schedule: '0 9 * * 1-5'
        },
        rpc
      )
    ).toEqual({ ok: true, value: { automationId: 'new' } })
    const [, params, options] =
      rpc.mock.calls.find(([method]) => method === 'automation.create') ?? []
    expect(params).toEqual({
      name: 'Deps',
      prompt: 'Check dependencies',
      agentId: 'codex',
      repo: 'id:r1',
      workspaceMode: 'new_per_run',
      rrule: '0 9 * * 1-5',
      dtstart: expect.any(Number),
      enabled: true
    })
    expect(options?.plugin).toEqual({ key: 'samples.demo', name: 'samples.demo' })
  })

  it('refuses a precheck, agent arguments, launch setup and setup choices', async () => {
    const rpc = runtime()
    const base = { name: 'x', prompt: 'y', agent: 'claude', projectId: 'r1', schedule: '0 9 * * *' }
    const outcomes = await Promise.all(
      [
        { precheck: { command: 'rm -rf ~', timeoutSeconds: 1 } },
        { agentArgs: '--yolo' },
        { extraAgentArgs: '--yolo' },
        { launchSetupPatch: { choices: {} } },
        { setupDecision: 'run' },
        { createdBy: { kind: 'plugin', pluginKey: 'other.plugin' } }
      ].map((extra) => call('automation.create', { ...base, ...extra }, rpc))
    )
    for (const outcome of outcomes) {
      expect(outcome).toMatchObject({ ok: false, code: 'invalid_params' })
    }
    expect(rpc).not.toHaveBeenCalled()
  })
})

describe('automation.update and automation.delete', () => {
  it("change the plugin's own automations without asking", async () => {
    const rpc = runtime()
    const confirm = vi.fn()
    expect(
      await call('automation.update', { automationId: 'a2', enabled: false }, rpc, { confirm })
    ).toEqual({ ok: true, value: { updated: true } })
    expect(confirm).not.toHaveBeenCalled()
    expect(rpc.mock.calls.find(([method]) => method === 'automation.update')?.[1]).toEqual({
      id: 'a2',
      updates: { enabled: false }
    })
  })

  it("ask before touching another's, and change nothing when refused or nobody can answer", async () => {
    const cancelled = runtime()
    const confirm = vi.fn().mockResolvedValue('cancelled')
    expect(await call('automation.delete', { automationId: 'a1' }, cancelled, { confirm })).toEqual(
      { ok: true, value: { deleted: false, reason: 'cancelled' } }
    )
    expect(confirm).toHaveBeenCalledWith(
      'samples.demo',
      { kind: 'automation.delete', name: 'Nightly sweep' },
      expect.anything()
    )
    expect(methods(cancelled)).not.toContain('automation.delete')

    // Headless serve has no window to ask in.
    const headless = runtime()
    expect(
      await call('automation.update', { automationId: 'a1', prompt: 'new' }, headless)
    ).toEqual({ ok: true, value: { updated: false, reason: 'consent-unavailable' } })
    expect(methods(headless)).not.toContain('automation.update')

    const allowed = runtime()
    const allow = vi.fn().mockResolvedValue('allowed')
    expect(
      await call('automation.delete', { automationId: 'a1' }, allowed, { confirm: allow })
    ).toEqual({
      ok: true,
      value: { deleted: true }
    })
  })

  it("ask before a new prompt or resuming for one that runs with extra agent settings, even the plugin's own", async () => {
    const confirm = vi.fn().mockResolvedValue('allowed')
    const rpc = runtime()
    await call('automation.update', { automationId: 'a3', prompt: 'Do more' }, rpc, { confirm })
    expect(confirm).toHaveBeenCalledWith(
      'samples.demo',
      {
        kind: 'automation.update',
        name: 'Nightly sweep',
        fields: ['prompt'],
        elevated: true,
        prompt: 'Do more'
      },
      expect.anything()
    )
    confirm.mockClear()
    // A new time zone moves when it runs.
    await call('automation.update', { automationId: 'a3', timezone: 'Asia/Tokyo' }, rpc, {
      confirm
    })
    expect(confirm).toHaveBeenCalledWith(
      'samples.demo',
      expect.objectContaining({ elevated: true, fields: ['timezone'] }),
      expect.anything()
    )
    confirm.mockClear()
    // A rename runs nothing new.
    await call('automation.update', { automationId: 'a3', name: 'Renamed' }, rpc, { confirm })
    expect(confirm).not.toHaveBeenCalled()
  })

  it('ask once the plugin that made it was removed or disabled', async () => {
    const confirm = vi.fn().mockResolvedValue('cancelled')
    const rpc = runtime()
    expect(await call('automation.delete', { automationId: 'a4' }, rpc, { confirm })).toEqual({
      ok: true,
      value: { deleted: false, reason: 'cancelled' }
    })
  })
})

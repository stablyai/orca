// P1-14 (ninth principal site): a terminal-create agentLaunch resolves against
// the PAIRED DEVICE's admission principal, so two phones cannot spend one
// launch-capacity bucket. An unpaired/local caller keeps the coarse principal —
// the bucket pre-device persisted rows were counted in.
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { resolveTerminalAgentLaunch } from './terminal-agent-launch-resolution'
import {
  AgentLaunchAdmissionStore,
  MAX_PENDING_LAUNCHES_PER_PRINCIPAL,
  admissionPrincipalOwns,
  type AdmissionPrincipal
} from '../agent-launch/agent-launch-admission-store'
import type { AgentLaunchSnapshot } from '../../shared/agent-launch-host-contract'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

vi.mock('./terminal-agent-launch-resolution', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    // A typed pre-spawn failure short-circuits both create paths after the
    // principal has already been built — all this test cares about.
    resolveTerminalAgentLaunch: vi.fn(async () => ({
      kind: 'failed',
      outcome: {
        status: 'failed',
        failure: { code: 'base_agent_disabled', baseAgent: 'claude' }
      }
    }))
  }
})

const resolveMock = vi.mocked(resolveTerminalAgentLaunch)

type Internals = {
  resolveAgentTerminalCreateOptions: (workspace: unknown, opts: unknown) => Promise<unknown>
  resolveMobileTerminalStartup: (workspace: unknown, opts: unknown) => Promise<unknown>
}

const WORKSPACE = { id: 'wt-1', path: '/wt', connectionId: null, repo: null }
const AGENT_LAUNCH = { selection: { kind: 'agent', agent: 'claude' } }

function makeRuntime(): Internals {
  const runtime = new OrcaRuntimeService()
  ;(runtime as unknown as { store: unknown }).store = {
    getSettings: () => ({})
  }
  return runtime as unknown as Internals
}

async function principalFor(
  path: 'terminal' | 'mobile',
  opts: { clientKind?: 'mobile' | 'runtime'; deviceId?: string }
): Promise<AdmissionPrincipal> {
  resolveMock.mockClear()
  const internals = makeRuntime()
  const createOpts = { agentLaunch: AGENT_LAUNCH, ...opts }
  await (path === 'terminal'
    ? internals.resolveAgentTerminalCreateOptions(WORKSPACE, createOpts)
    : internals.resolveMobileTerminalStartup(WORKSPACE, createOpts))
  return (resolveMock.mock.calls[0]![1] as { principal: AdmissionPrincipal }).principal
}

function snapshot(): AgentLaunchSnapshot {
  return {
    baseAgent: 'claude',
    target: { executionHostId: 'local' }
  } as unknown as AgentLaunchSnapshot
}

function admit(
  store: AgentLaunchAdmissionStore,
  principal: AdmissionPrincipal,
  scope: string
): boolean {
  return store.admit({
    principal,
    intent: 'interactive',
    scope,
    worktreeId: null,
    fingerprint: 'fp',
    snapshot: snapshot(),
    admittedAt: 1
  }).ok
}

describe.each(['terminal', 'mobile'] as const)(
  '%s terminal-create agentLaunch admission principal',
  (path) => {
    it('scopes the principal to the authenticated paired device', async () => {
      expect(
        await principalFor(path, {
          clientKind: 'mobile',
          deviceId: 'device-a'
        })
      ).toEqual({
        kind: 'remote',
        id: 'mobile',
        deviceId: 'device-a'
      })
    })

    it('keeps the coarse principal when the transport carries no paired device', async () => {
      // Legacy/pre-device rows were persisted under this exact key; an
      // `undefined`-valued deviceId would fork it.
      expect(await principalFor(path, { clientKind: 'mobile' })).toEqual({
        kind: 'remote',
        id: 'mobile'
      })
    })

    it('is local for an in-process desktop caller', async () => {
      expect(await principalFor(path, {})).toEqual({ kind: 'local' })
    })

    it('gives two paired devices isolated capacity buckets', async () => {
      const deviceA = await principalFor(path, {
        clientKind: 'mobile',
        deviceId: 'device-a'
      })
      const deviceB = await principalFor(path, {
        clientKind: 'mobile',
        deviceId: 'device-b'
      })
      const store = new AgentLaunchAdmissionStore()

      for (let i = 0; i < MAX_PENDING_LAUNCHES_PER_PRINCIPAL; i += 1) {
        expect(admit(store, deviceA, `wt-a-${i}`)).toBe(true)
      }

      expect(admit(store, deviceA, 'wt-a-over')).toBe(false)
      // Before the device id was threaded, both phones shared `remote:mobile`
      // and the second device was rejected here.
      expect(admit(store, deviceB, 'wt-b-1')).toBe(true)
    })

    it('still owns a legacy coarse-principal row admitted before device scoping', async () => {
      const device = await principalFor(path, {
        clientKind: 'mobile',
        deviceId: 'device-a'
      })
      const store = new AgentLaunchAdmissionStore()
      const legacy: AdmissionPrincipal = { kind: 'remote', id: 'mobile' }
      expect(admit(store, legacy, 'wt-legacy')).toBe(true)

      // Forget/recovery surfaces join through ownership, so a pre-upgrade row
      // must stay visible and claimable by any device of its kind.
      expect(admissionPrincipalOwns(device, legacy)).toBe(true)
      expect(store.capacitySummaryFor(device).map((row) => row.scope)).toContain('wt-legacy')
    })
  }
)

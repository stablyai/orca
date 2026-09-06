import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import {
  getStructuredAgentSessionHost,
  setStructuredAgentSessionHost
} from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { agentSessionPtyWriteGate } from './agent-session-pty-write-gate'

type InstallEffects = {
  storeOpened: boolean
  writeGateAttached: boolean
  reaperStarted: boolean
}

/** Stands in for `install()` by performing the three effects it performs, so a probe that
 *  reinstalls the host is caught by what the install *does*, not by a call count alone. */
function stubStructuredHostInstall(runtime: OrcaRuntimeService): {
  effects: InstallEffects
  ensure: ReturnType<typeof vi.fn>
} {
  const effects: InstallEffects = {
    storeOpened: false,
    writeGateAttached: false,
    reaperStarted: false
  }
  // `supportsCreate` answers as the real Codex adapter would, so a probe that reinstalls the host
  // still returns the right answer and fails on the install effects alone.
  const host = {
    reconcileRestartLeases: vi.fn(async () => {}),
    supportsCreate: (location: { executionHostId: string; wslDistro: string | null }) =>
      location.executionHostId === 'local' && location.wslDistro === null
  }
  const ensure = vi.fn(async () => {
    effects.storeOpened = true
    effects.reaperStarted = true
    agentSessionPtyWriteGate.attachRecordLookup(() => null)
    effects.writeGateAttached = true
    setStructuredAgentSessionHost(host as never)
  })
  vi.spyOn(runtime, 'ensureStructuredAgentSessionHost').mockImplementation(ensure)
  return { effects, ensure }
}

type TestLocation = {
  executionHostId: string
  wslDistro: string | null
  workspaceKind?: 'folder' | 'git-worktree'
}

type SupportResult = {
  supported: boolean
  reason?: 'agent' | 'remote' | 'wsl'
}

function createRuntime(location: TestLocation): OrcaRuntimeService {
  const runtime = new OrcaRuntimeService({ getSettings: () => ({}) } as never)
  const internal = runtime as unknown as {
    resolveStructuredAgentSessionLocation: () => Promise<unknown>
  }
  internal.resolveStructuredAgentSessionLocation = vi.fn(async () => ({
    executionHostId: location.executionHostId,
    wslDistro: location.wslDistro,
    workspaceId: 'workspace-1',
    workspaceKind: location.workspaceKind ?? 'git-worktree'
  }))
  return runtime
}

async function expectSupportWithoutInstall(input: {
  agent: 'claude' | 'codex'
  location: TestLocation
  expected: SupportResult
  repetitions?: number
}): Promise<void> {
  const runtime = createRuntime(input.location)
  const { effects, ensure } = stubStructuredHostInstall(runtime)

  const answers: SupportResult[] = []
  for (let index = 0; index < (input.repetitions ?? 1); index += 1) {
    answers.push(
      await runtime.getStructuredAgentSessionCreateSupport('id:workspace-1', input.agent)
    )
  }

  expect(answers).toEqual(Array(input.repetitions ?? 1).fill(input.expected))
  expect(ensure).not.toHaveBeenCalled()
  expect(effects).toEqual({
    storeOpened: false,
    writeGateAttached: false,
    reaperStarted: false
  })
  expect(getStructuredAgentSessionHost()).toBeNull()
}

describe('structured agent-session create-support probe', () => {
  afterEach(() => {
    setStructuredAgentSessionHost(null)
    agentSessionPtyWriteGate.detachRecordLookup()
    vi.restoreAllMocks()
  })

  it.each(['codex', 'claude'] as const)(
    'answers %s support repeatedly without installing the host',
    async (agent) => {
      await expectSupportWithoutInstall({
        agent,
        location: { executionHostId: 'local', wslDistro: null },
        expected: { supported: true },
        repetitions: 3
      })
    }
  )

  it.each(['codex', 'claude'] as const)(
    'still reports an unsupported remote %s location without installing the host',
    async (agent) => {
      await expectSupportWithoutInstall({
        agent,
        location: { executionHostId: 'ssh-host-1', wslDistro: null },
        expected: { supported: false, reason: 'remote' }
      })
    }
  )

  it.each(['codex', 'claude'] as const)(
    'still reports an unsupported WSL %s location without installing the host',
    async (agent) => {
      await expectSupportWithoutInstall({
        agent,
        location: { executionHostId: 'local', wslDistro: 'Ubuntu' },
        expected: { supported: false, reason: 'wsl' }
      })
    }
  )

  it.each(['codex', 'claude'] as const)(
    'supports a local folder workspace for %s without installing the host',
    async (agent) => {
      await expectSupportWithoutInstall({
        agent,
        location: {
          executionHostId: 'local',
          wslDistro: null,
          workspaceKind: 'folder'
        },
        expected: { supported: true }
      })
    }
  )

  it('still installs and reconciles on startup when a store is already persisted', async () => {
    const runtime = createRuntime({ executionHostId: 'local', wslDistro: null })
    const { effects, ensure } = stubStructuredHostInstall(runtime)
    const internal = runtime as unknown as {
      hasPersistedStructuredAgentSessionStore: () => boolean
      refreshMobileSessionPtyRecords: () => Promise<void>
    }
    internal.hasPersistedStructuredAgentSessionStore = () => true
    internal.refreshMobileSessionPtyRecords = vi.fn(async () => {})

    await runtime.prepareStructuredAgentSessionStartupRestoration()

    expect(ensure).toHaveBeenCalledTimes(1)
    expect(effects).toEqual({
      storeOpened: true,
      writeGateAttached: true,
      reaperStarted: true
    })
    expect(
      (getStructuredAgentSessionHost() as unknown as { reconcileRestartLeases: () => void })
        .reconcileRestartLeases
    ).toHaveBeenCalledTimes(1)
  })
})

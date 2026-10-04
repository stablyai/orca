import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../shared/agent-session-record.test-fixture'
import { afterEach, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import * as loginShellEnvironment from '../startup/login-shell-environment'
import { createCursorStructuredLaunchResolver } from './cursor-structured-launch-resolution'

afterEach(() => vi.restoreAllMocks())

it.each([
  {
    name: 'inherited Cursor root',
    base: { CURSOR_CONFIG_DIR: join(tmpdir(), 'inherited-cursor') },
    overlay: {},
    expected: join(tmpdir(), 'inherited-cursor')
  },
  {
    name: 'inherited XDG root',
    base: { XDG_CONFIG_HOME: join(tmpdir(), 'inherited-xdg') },
    overlay: {},
    expected: join(tmpdir(), 'inherited-xdg', 'cursor')
  },
  {
    name: 'explicit Cursor override',
    base: { CURSOR_CONFIG_DIR: join(tmpdir(), 'inherited-cursor') },
    overlay: { CURSOR_CONFIG_DIR: join(tmpdir(), 'explicit-cursor') },
    expected: join(tmpdir(), 'explicit-cursor')
  }
])(
  'pins $name at actual create intent and retains it when host settings change',
  async ({ base, overlay, expected }) => {
    const inherited = { HOME: tmpdir(), PATH: '', ...base }
    vi.spyOn(loginShellEnvironment, 'resolveLoginShellEnvironment').mockResolvedValue(inherited)
    const runtime = new OrcaRuntimeService(null)
    const location = {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'folder:account-proof',
      workspaceKind: 'folder' as const
    }
    Object.assign(runtime, {
      store: { getSettings: () => ({ agentDefaultEnv: { cursor: overlay } }) },
      resolveStructuredAgentSessionLocation: async () => location
    })
    vi.spyOn(runtime, 'getStructuredAgentSessionCreateSupport').mockResolvedValue({
      supported: true
    })
    const intent = await runtime.resolveStructuredAgentSessionCreateIntent({
      envelope: { sessionId: 'cursor-account-proof', clientOperationId: 'cursor-operation' },
      worktree: location.workspaceId,
      agent: 'cursor'
    })
    expect(intent.accountHome).toEqual({ variable: 'CURSOR_CONFIG_DIR', path: expected })
    const resolve = createCursorStructuredLaunchResolver({
      store: {
        getRecord: () => ({
          ...agentSessionRecordFixture(agentSessionLeaseFixture()),
          sessionId: 'cursor-account-proof',
          provider: 'cursor',
          accountHome: intent.accountHome,
          location: intent.location,
          providerHandleChain: []
        })
      },
      resolveWorkspacePath: async () => tmpdir(),
      resolveEnvironment: async () => ({
        HOME: tmpdir(),
        PATH: '',
        CURSOR_CONFIG_DIR: 'changed-base'
      }),
      resolveRecipe: () => ({ env: { CURSOR_CONFIG_DIR: 'changed-overlay' } })
    })
    const launch = await resolve({
      identity: {
        sessionId: 'cursor-account-proof',
        workspaceId: location.workspaceId,
        hostId: 'local',
        agent: 'cursor',
        providerHandle: { kind: 'opaque', agent: 'cursor', value: 'pending' }
      },
      fence: 1,
      spawnToken: 'cursor-spawn'
    })
    expect(launch.env?.CURSOR_CONFIG_DIR).toBe(expected)
    expect((await runtime.resolveStructuredAgentAccountHome('cursor')).path).toBe(expected)
  }
)

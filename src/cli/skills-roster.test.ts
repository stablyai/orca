import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

const { detectCommandsMock, runtimeCallMock, readHookSettingsMock, readHookSettingsFromDiskMock } =
  vi.hoisted(() => ({
    detectCommandsMock: vi.fn(() => new Set<string>(['claude'])),
    runtimeCallMock: vi.fn(),
    readHookSettingsMock: vi.fn(),
    readHookSettingsFromDiskMock: vi.fn(() => ({
      agentStatusHooksEnabled: true,
      disabledTuiAgents: [] as string[]
    }))
  }))

vi.mock('../shared/local-agent-install-dir-detection', () => ({
  detectCommandsInInstallDirs: detectCommandsMock
}))

vi.mock('./handlers/agent-hooks', () => ({
  readHookSettings: readHookSettingsMock,
  readHookSettingsFromDisk: readHookSettingsFromDiskMock
}))

vi.mock('./bundled-skill-guides.js', () => ({
  BUNDLED_SKILL_GUIDES: [
    {
      name: 'alpha',
      description: 'Use when alpha work is needed.',
      markdown: '# Alpha\n',
      fullMarkdown: '# Alpha\n',
      aliases: []
    }
  ]
}))

import type { HandlerContext } from './dispatch'
import { SKILL_HANDLERS } from './handlers/skills'

function context(
  flags: Map<string, string | boolean>,
  json = false,
  isRemote = false
): HandlerContext {
  return {
    flags,
    client: { call: runtimeCallMock, isRemote } as never,
    cwd: '/tmp/repo',
    json
  }
}

async function install(
  flags: Map<string, string | boolean>,
  json = false,
  isRemote = false
): Promise<void> {
  await SKILL_HANDLERS['skills install']!(context(flags, json, isRemote))
}

describe('skills install agent roster', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    detectCommandsMock.mockReset()
    detectCommandsMock.mockReturnValue(new Set<string>(['claude']))
    runtimeCallMock.mockReset()
    readHookSettingsMock.mockReset()
    readHookSettingsMock.mockImplementation(async (client) => {
      try {
        const response = await client.call('settings.get', undefined, { timeoutMs: 1_000 })
        return response.result.settings
      } catch {
        return readHookSettingsFromDiskMock()
      }
    })
    readHookSettingsFromDiskMock.mockReset()
    readHookSettingsFromDiskMock.mockReturnValue({
      agentStatusHooksEnabled: true,
      disabledTuiAgents: []
    })
    runtimeCallMock.mockResolvedValue({
      result: {
        settings: {
          agentStatusHooksEnabled: true,
          defaultTuiAgent: null,
          disabledTuiAgents: []
        }
      }
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('maps enabled detected agents onto the skills CLI namespace', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    detectCommandsMock.mockReturnValue(new Set<string>(['claude', 'cursor-agent', 'rovo']))

    await install(
      new Map<string, string | boolean>([
        ['skill', 'alpha'],
        ['dry-run', true]
      ])
    )

    expect(stdoutText(stdoutSpy)).toContain(
      '--agent claude-code --agent cursor --agent rovodev --agent universal'
    )
  })

  it('filters implicit skill targets to enabled detected agents', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    detectCommandsMock.mockReturnValue(new Set<string>(['claude', 'codex', 'rovo']))
    runtimeCallMock.mockResolvedValue({
      result: {
        settings: {
          agentStatusHooksEnabled: true,
          defaultTuiAgent: null,
          disabledTuiAgents: ['claude', 'rovo']
        }
      }
    })

    await install(
      new Map<string, string | boolean>([
        ['skill', 'alpha'],
        ['dry-run', true]
      ])
    )

    expect(stdoutText(stdoutSpy)).toContain('--agent codex --agent universal')
    expect(stdoutText(stdoutSpy)).not.toContain('--agent claude-code')
    expect(stdoutText(stdoutSpy)).not.toContain('--agent rovodev')
    expect(runtimeCallMock).toHaveBeenCalledWith('settings.get', undefined, { timeoutMs: 1_000 })
  })

  it('uses the persisted local roster for a remote runtime selection', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    detectCommandsMock.mockReturnValue(new Set<string>(['claude', 'codex']))
    readHookSettingsFromDiskMock.mockReturnValue({
      agentStatusHooksEnabled: true,
      disabledTuiAgents: ['claude']
    })

    await install(
      new Map<string, string | boolean>([
        ['skill', 'alpha'],
        ['dry-run', true]
      ]),
      false,
      true
    )

    expect(stdoutText(stdoutSpy)).toContain('--agent codex --agent universal')
    expect(stdoutText(stdoutSpy)).not.toContain('--agent claude-code')
    expect(runtimeCallMock).not.toHaveBeenCalled()
    expect(readHookSettingsMock).not.toHaveBeenCalled()
    expect(readHookSettingsFromDiskMock).toHaveBeenCalledOnce()
  })

  it('uses the persisted local roster when the local runtime is unavailable', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    detectCommandsMock.mockReturnValue(new Set<string>(['codex', 'rovo']))
    runtimeCallMock.mockRejectedValue(new Error('runtime unavailable'))
    readHookSettingsFromDiskMock.mockReturnValue({
      agentStatusHooksEnabled: true,
      disabledTuiAgents: ['rovo']
    })

    await install(
      new Map<string, string | boolean>([
        ['skill', 'alpha'],
        ['dry-run', true]
      ])
    )

    expect(stdoutText(stdoutSpy)).toContain('--agent codex --agent universal')
    expect(stdoutText(stdoutSpy)).not.toContain('--agent rovodev')
    expect(runtimeCallMock).toHaveBeenCalledWith('settings.get', undefined, { timeoutMs: 1_000 })
    expect(readHookSettingsMock).toHaveBeenCalledOnce()
    expect(readHookSettingsFromDiskMock).toHaveBeenCalledOnce()
  })

  it('preserves an explicitly named disabled agent without reading the roster', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    detectCommandsMock.mockReturnValue(new Set<string>())
    runtimeCallMock.mockRejectedValue(new Error('roster unavailable'))

    await install(
      new Map<string, string | boolean>([
        ['skill', 'alpha'],
        ['agent', 'codex'],
        ['dry-run', true]
      ])
    )

    expect(stdoutText(stdoutSpy)).toContain('--agent codex')
    expect(runtimeCallMock).not.toHaveBeenCalled()
    expect(readHookSettingsMock).not.toHaveBeenCalled()
    expect(readHookSettingsFromDiskMock).not.toHaveBeenCalled()
    expect(detectCommandsMock).not.toHaveBeenCalled()
  })

  it('omits disabled detections from an all-skills JSON dry run', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    detectCommandsMock.mockReturnValue(new Set<string>(['claude', 'codex']))
    runtimeCallMock.mockResolvedValue({
      result: {
        settings: {
          agentStatusHooksEnabled: true,
          defaultTuiAgent: null,
          disabledTuiAgents: ['claude']
        }
      }
    })

    await install(
      new Map<string, string | boolean>([
        ['all', true],
        ['dry-run', true]
      ]),
      true
    )

    const output = JSON.parse(stdoutText(stdoutSpy)) as { command: string }
    expect(output.command).toContain('--agent codex --agent universal')
    expect(output.command).not.toContain('--agent claude-code')
  })
})

function stdoutText(spy: MockInstance): string {
  return spy.mock.calls.map((call) => String(call[0])).join('')
}

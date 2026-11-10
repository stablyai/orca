import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as FsPromises from 'node:fs/promises'
import type * as CommandPathResolver from '../ipc/command-path/command-path-resolver'
import { setMainHttpClient } from '../network/http-client'
import { checkAgentUpdates } from './check-agent-updates'

const { runProcess, detectInstalledAgentsWithShellPathHydration, resolveCommandOnLocalPath } =
  vi.hoisted(() => ({
    runProcess: vi.fn(),
    detectInstalledAgentsWithShellPathHydration: vi.fn(),
    resolveCommandOnLocalPath: vi.fn()
  }))
vi.mock('@orca/process-host', () => ({ runProcess }))
const { WINDOWS_CRUSH_SHIM } = vi.hoisted(() => ({
  WINDOWS_CRUSH_SHIM: 'C:\\Users\\dev\\AppData\\Roaming\\npm\\crush.cmd'
}))
// Why: npm's Windows shim is a batch file pointing into node_modules, not a symlink.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  const shim = '@ECHO off\r\n"%dp0%\\node_modules\\@charmland\\crush\\bin\\crush.exe" %*\r\n'
  const open = async (...args: Parameters<typeof actual.open>) =>
    args[0] === WINDOWS_CRUSH_SHIM
      ? {
          read: async (buffer: Buffer) => ({ bytesRead: buffer.write(shim) }),
          close: async () => undefined
        }
      : actual.open(...args)
  return { ...actual, default: { ...actual, open }, open }
})
vi.mock('../preflight/installed-agent-detection', () => ({
  detectInstalledAgentsWithShellPathHydration,
  agentCommandOverrideDetectionOptions: () => undefined
}))
vi.mock('../ipc/command-path/command-path-resolver', async (importOriginal) => ({
  ...(await importOriginal<typeof CommandPathResolver>()),
  resolveCommandOnLocalPath
}))

const CRUSH_LATEST_URL = 'https://api.github.com/repos/charmbracelet/crush/releases/latest'
const CLAUDE_LATEST_URL = 'https://registry.npmjs.org/@anthropic-ai/claude-code/latest'
const CODEX_LATEST_URL = 'https://registry.npmjs.org/@openai/codex/latest'
const SETTINGS = { disabledTuiAgents: [], agentCmdOverrides: {} }

type VersionResult = { code: number; stdout: string }

const versionOutput = new Map<string, VersionResult>()
const latestBody = new Map<string, Response>()
const fetch = vi.fn(async (url: string) => latestBody.get(url) ?? new Response('', { status: 500 }))

function installed(agents: Record<string, VersionResult>): void {
  detectInstalledAgentsWithShellPathHydration.mockResolvedValue(Object.keys(agents))
  for (const [agent, result] of Object.entries(agents)) {
    versionOutput.set(`/opt/bin/${agent}`, result)
  }
}

function latest(url: string, version: string): void {
  latestBody.set(url, new Response(JSON.stringify({ version }), { status: 200 }))
}

function installedCrushAt(crushBinary: string): void {
  installed({ claude: { code: 0, stdout: '2.1.319 (Claude Code)\n' } })
  detectInstalledAgentsWithShellPathHydration.mockResolvedValue(['claude', 'crush'])
  resolveCommandOnLocalPath.mockImplementation(async (command: string) =>
    command === 'crush' ? crushBinary : `/opt/bin/${command}`
  )
  versionOutput.set(crushBinary, { code: 0, stdout: 'crush version v0.100.0\n' })
  latest(CLAUDE_LATEST_URL, '2.1.320')
  latestBody.set(
    CRUSH_LATEST_URL,
    new Response(JSON.stringify({ tag_name: 'v0.101.0' }), { status: 200 })
  )
}

const CLAUDE_ROW = {
  agent: 'claude',
  current: '2.1.319',
  latest: '2.1.320',
  updateAvailable: true,
  action: { kind: 'run' },
  run: null
}

describe('checkAgentUpdates', () => {
  beforeEach(() => {
    resolveCommandOnLocalPath.mockImplementation(async (command: string) => `/opt/bin/${command}`)
    runProcess.mockImplementation(async ({ program }: { program: string }) => ({
      signal: null,
      stderr: '',
      timedOut: false,
      ...(versionOutput.get(program) ?? { code: 127, stdout: '' })
    }))
    setMainHttpClient({ fetch, proxySession: () => null })
  })

  afterEach(() => {
    setMainHttpClient(null)
    versionOutput.clear()
    latestBody.clear()
    vi.clearAllMocks()
  })

  it('reports each installed outdated agent and checks no other source', async () => {
    installed({
      claude: { code: 0, stdout: '2.1.319 (Claude Code)\n' },
      codex: { code: 0, stdout: 'codex-cli 0.166.0\n' }
    })
    latest(CLAUDE_LATEST_URL, '2.1.320')
    latest(CODEX_LATEST_URL, '0.167.0')

    expect((await checkAgentUpdates(SETTINGS)).rows).toEqual([
      CLAUDE_ROW,
      {
        agent: 'codex',
        current: '0.166.0',
        latest: '0.167.0',
        updateAvailable: true,
        action: { kind: 'run' },
        run: null
      }
    ])
    expect(fetch.mock.calls.map(([url]) => url).sort()).toEqual([
      CLAUDE_LATEST_URL,
      CODEX_LATEST_URL
    ])
  })

  it('drops only the agent whose latest version lookup fails', async () => {
    installed({
      claude: { code: 0, stdout: '2.1.319 (Claude Code)\n' },
      codex: { code: 0, stdout: 'codex-cli 0.166.0\n' }
    })
    latest(CLAUDE_LATEST_URL, '2.1.320')
    latestBody.set(CODEX_LATEST_URL, new Response('Not Found', { status: 404 }))

    expect((await checkAgentUpdates(SETTINGS)).rows).toEqual([CLAUDE_ROW])
  })

  it.each([
    ['exits non-zero', { code: 1, stdout: 'codex-cli 0.166.0\n' }],
    ['prints nothing', { code: 0, stdout: '' }]
  ])('drops only the agent whose version command %s', async (_case, codexResult) => {
    installed({ claude: { code: 0, stdout: '2.1.319 (Claude Code)\n' }, codex: codexResult })
    latest(CLAUDE_LATEST_URL, '2.1.320')
    latest(CODEX_LATEST_URL, '0.167.0')

    expect((await checkAgentUpdates(SETTINGS)).rows).toEqual([CLAUDE_ROW])
  })

  it('reports nothing when the installed version is already the latest', async () => {
    installed({ claude: { code: 0, stdout: '2.1.319 (Claude Code)\n' } })
    latest(CLAUDE_LATEST_URL, '2.1.319')

    expect((await checkAgentUpdates(SETTINGS)).rows).toEqual([])
  })

  it('does not offer a newer major release line to a same-major-only agent', async () => {
    installed({
      claude: { code: 0, stdout: '2.1.319 (Claude Code)\n' },
      opencode: { code: 0, stdout: 'opencode 1.19.5\n' }
    })
    latest(CLAUDE_LATEST_URL, '2.1.320')
    latest('https://registry.npmjs.org/opencode-ai/latest', '2.2.5')

    expect((await checkAgentUpdates(SETTINGS)).rows).toEqual([CLAUDE_ROW])
  })

  it('leaves a Homebrew install alone when only install-limited or manual steps exist', async () => {
    installedCrushAt('/opt/homebrew/Cellar/crush/0.100.0/bin/crush')

    expect((await checkAgentUpdates(SETTINGS)).rows).toEqual([CLAUDE_ROW])
  })

  it('skips an agent whose override runs it through a wrapper and never probes the wrapper', async () => {
    installed({ codex: { code: 0, stdout: 'codex-cli 0.166.0\n' } })
    versionOutput.set('/opt/bin/uvx', { code: 0, stdout: 'uv 0.9.5\n' })
    latest(CODEX_LATEST_URL, '0.167.0')
    const settings = { ...SETTINGS, agentCmdOverrides: { codex: 'uvx some-wrapper --flag' } }

    expect((await checkAgentUpdates(settings)).rows).toEqual([])
    expect(runProcess.mock.calls.map(([spec]) => spec.program)).not.toContain('/opt/bin/uvx')
  })

  it('leaves a Homebrew install alone even when its only step is npm', async () => {
    const gemini =
      '/opt/homebrew/Cellar/gemini-cli/0.67.0/libexec/lib/node_modules/@google/gemini-cli/dist/index.js'
    detectInstalledAgentsWithShellPathHydration.mockResolvedValue(['gemini'])
    resolveCommandOnLocalPath.mockResolvedValue(gemini)
    versionOutput.set(gemini, { code: 0, stdout: '0.67.0\n' })
    latest('https://registry.npmjs.org/@google/gemini-cli/latest', '0.68.0')

    expect((await checkAgentUpdates(SETTINGS)).rows).toEqual([])
  })

  it('treats a Windows npm shim as an npm install', async () => {
    installedCrushAt(WINDOWS_CRUSH_SHIM)

    expect((await checkAgentUpdates(SETTINGS)).rows).toEqual([
      CLAUDE_ROW,
      {
        agent: 'crush',
        current: '0.100.0',
        latest: '0.101.0',
        updateAvailable: true,
        action: { kind: 'run' },
        run: null
      }
    ])
  })
})

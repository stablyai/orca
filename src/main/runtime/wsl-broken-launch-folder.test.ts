import '../daemon/mock-descendant-sweep'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveAgentStartupPlanInputs } from '../../shared/agent-startup-plan-inputs'
import { buildStartupCommandSubmission } from '../../shared/startup-command-submission'
import { planLaunchPrompt } from '../../shared/tui-agent-startup'
import type { TuiAgent } from '../../shared/tui-agent'
import type { WslLaunchDirectory } from '../../shared/wsl-launch-directory'
import type * as WslPaths from '../../shared/wsl-paths'
import { TerminalHost } from '../daemon/terminal-host'
import type { SubprocessHandle } from '../daemon/session-subprocess-handle'
import { noteLaunchArtifactRefusal } from '../providers/local-launch-artifact-directory'
import { resolveSpawnWslLaunchDirectory } from '../providers/wsl-launch-directory-resolution'
import { getAgentLaunchPlatformForRepo } from './runtime-agent-launch-resolution'
import { probedThisOrcaLaunchHost } from './this-orca-launch-host'

const { runWslProcess, uncSide } = vi.hoisted(() => {
  const side: { path: string | null } = { path: null }
  return { runWslProcess: vi.fn(), uncSide: side }
})
vi.mock('../wsl/wsl-runner', () => ({ runWslProcess }))
// Stands in for `\\wsl.localhost\<distro>\root\.cache\orca`, which only Windows can open.
vi.mock('../../shared/wsl-paths', async (importOriginal) => {
  const actual = await importOriginal<typeof WslPaths>()
  return {
    ...actual,
    toWindowsWslUncPath: (linuxPath: string, distro: string) =>
      uncSide.path ?? actual.toWindowsWslUncPath(linuxPath, distro)
  }
})

// The stack QA's prompts (2a): one long line and five short ones.
const P25K = 'QA-STACK P25K one line, inert. '.padEnd(25_600, 'x')
const ML5 = [1, 2, 3, 4, 5].map((i) => `QA-STACK ML5 line ${i}: inert text.`).join('\n')

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
let scratch: string
let exitSubprocess: ((code: number) => void) | undefined

beforeEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  scratch = mkdtempSync(join(tmpdir(), 'orca-wsl-broken-folder-'))
  exitSubprocess = undefined
})

afterEach(() => {
  Object.defineProperty(process, 'platform', originalPlatform)
  rmSync(scratch, { recursive: true, force: true })
  uncSide.path = null
  vi.clearAllMocks()
})

function probeAnswers(home: string | null) {
  return {
    environmentResolved: true,
    code: home ? 0 : 1,
    stdout: home ? `${home}\n/bin/bash\n` : '',
    stderr: home ? '' : 'mkdir: cannot create directory: File exists',
    timedOut: false
  }
}

function wslRepoPath(distro: string): string {
  return `\\\\wsl.localhost\\${distro}\\root\\fixture`
}

/** What `agent.launch` plans, with its paste for an uncarried prompt. */
async function planAgentLaunch(distro: string, agent: TuiAgent, prompt: string) {
  const repo = { connectionId: null, path: wslRepoPath(distro) }
  const platform = getAgentLaunchPlatformForRepo(repo)
  const settings = { terminalWindowsShell: 'powershell.exe' }
  return planLaunchPrompt({
    ...resolveAgentStartupPlanInputs({ agent, settings, platform, isRemote: false }),
    prompt,
    host: await probedThisOrcaLaunchHost({
      launchPlatform: platform,
      isRemote: false,
      settings,
      workspacePath: repo.path,
      prompt
    }),
    paste: 'when-host-proves-agent'
  })
}

function mockSubprocess(): SubprocessHandle {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handle stubs only what session creation calls.
  return {
    pid: 1,
    shellPath: 'C:\\Windows\\System32\\wsl.exe',
    getForegroundProcess: vi.fn(() => null),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(() => exitSubprocess?.(1)),
    terminateOwnedTree: () => 'unavailable' as const,
    forceKill: vi.fn(() => exitSubprocess?.(1)),
    signal: vi.fn(),
    onData: () => {},
    onExit: (callback: (code: number) => void) => {
      exitSubprocess = callback
    },
    dispose: vi.fn()
  } as SubprocessHandle
}

/** The spawn as main runs it: its probe, then the daemon's session create, noting a refusal. */
async function spawnAgentLine(
  distro: string,
  agent: TuiAgent,
  command: string,
  unstageableLine?: 'refuse'
) {
  const wslDistro = distro
  const probe = resolveSpawnWslLaunchDirectory(wslDistro, { command, launchAgent: agent })
  const wslLaunchDirectory: WslLaunchDirectory | undefined = probe ? await probe : undefined
  const sub = mockSubprocess()
  const host = new TerminalHost({ spawnSubprocess: () => sub })
  try {
    await host.createOrAttach({
      sessionId: `s-${distro}-${agent}-${command.length}`,
      cols: 80,
      rows: 24,
      cwd: wslRepoPath(distro),
      command,
      launchAgent: agent,
      ...(wslLaunchDirectory ? { wslLaunchDirectory } : {}),
      ...(unstageableLine ? { unstageableLine } : {}),
      shellReadySupported: false,
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })
  } catch (error) {
    noteLaunchArtifactRefusal({ wslDistro, wslLaunchDirectory }, error)
    return { refused: error, typed: vi.mocked(sub.write).mock.calls.map(([data]) => data) }
  }
  return { refused: null, typed: vi.mocked(sub.write).mock.calls.map(([data]) => data) }
}

/** What main types for `command` into a shell without bracketed paste. */
function typedAsMain(command: string): string {
  return buildStartupCommandSubmission(command, { bracketedPasteSafe: false })
}

async function launch(distro: string, agent: TuiAgent, prompt: string) {
  const planned = await planAgentLaunch(distro, agent, prompt)
  if (planned?.carry !== 'on-line') {
    throw new Error(`expected the line, got ${planned?.carry}`)
  }
  return {
    command: planned.plan.launchCommand,
    ...(await spawnAgentLine(distro, agent, planned.plan.launchCommand))
  }
}

// Why (stack QA 2a): with the distro's ~/.cache/orca unusable, main types the agent line as is (a
// 5-line prompt arrives exact); refusing it made that launch worse than main.
describe('agent.launch into a WSL workspace whose launch folder is unusable', () => {
  it.each<[TuiAgent, string, string]>([
    ['claude', 'P25K', P25K],
    ['claude', 'ML5', ML5],
    ['grok', 'P25K', P25K]
  ])(
    'types %s %s as main does when the folder was broken before first use',
    async (agent, tag, prompt) => {
      const distro = `qa-before-${agent}-${tag}`
      runWslProcess.mockResolvedValue(probeAnswers(null))
      const { command, refused, typed } = await launch(distro, agent, prompt)
      expect(command).toContain(prompt.split('\n')[0])
      expect(refused).toBeNull()
      expect(typed).toEqual([typedAsMain(command)])
    }
  )

  // Why the probe before planning: past the line's ceiling the plan would otherwise pick a launch
  // file, which a distro with no folder must refuse.
  it("plans a prompt past the line ceiling for main's line on the first launch", async () => {
    runWslProcess.mockResolvedValue(probeAnswers(null))
    const prompt = 'QA-STACK P120K one line, inert. '.padEnd(120_000, 'x')
    const { command, refused, typed } = await launch('qa-before-p120k', 'claude', prompt)
    expect(command).toContain(prompt)
    expect(refused).toBeNull()
    expect(typed).toEqual([typedAsMain(command)])
  })

  // Why: main pasted an AI button's or a note's prompt, so that caller asks to be refused rather
  // than have a line typed raw that can leave bash waiting.
  it('refuses a caller that asked to refuse, and still types a short line', async () => {
    runWslProcess.mockResolvedValue(probeAnswers(null))
    const distro = 'qa-before-refuse'
    await planAgentLaunch(distro, 'claude', P25K)
    const long = await spawnAgentLine(distro, 'claude', `claude '${P25K}'`, 'refuse')
    expect(String(long.refused)).toMatch(/launch_file_unavailable/)
    expect(long.typed).toEqual([])
    const short = await spawnAgentLine(distro, 'claude', `claude 'fix it'`, 'refuse')
    expect(short.refused).toBeNull()
  })

  it('refuses only the launch whose write failed after the probe found the folder, then types as main does', async () => {
    const distro = 'qa-after-first-use'
    const windowsSide = join(scratch, 'cache')
    runWslProcess.mockResolvedValue(probeAnswers('/root'))
    uncSide.path = windowsSide
    const first = await launch(distro, 'claude', P25K)
    expect(first.refused).toBeNull()
    expect(first.typed).toEqual([expect.stringMatching(/^\. '\/root\/\.cache\/orca\/orca-launch-/)])

    // The folder breaks after the probe found it: the probe said yes, so this write's failure is
    // the race, refused with nothing typed.
    rmSync(windowsSide, { recursive: true, force: true })
    writeFileSync(windowsSide, '')
    const raced = await launch(distro, 'claude', P25K)
    expect(String(raced.refused)).toMatch(/launch_file_unavailable/)
    expect(raced.typed).toEqual([])

    for (const prompt of [P25K, ML5]) {
      const later = await launch(distro, 'claude', prompt)
      expect(later.refused).toBeNull()
      expect(later.typed).toEqual([typedAsMain(later.command)])
    }
  })
})

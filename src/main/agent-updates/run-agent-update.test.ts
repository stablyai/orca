import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as CommandPathResolver from '../ipc/command-path/command-path-resolver'
import { runAgentUpdate } from './run-agent-update'

const { runProcess, resolveCommandOnLocalPath } = vi.hoisted(() => ({
  runProcess: vi.fn(),
  resolveCommandOnLocalPath: vi.fn()
}))
vi.mock('@orca/process-host', () => ({ runProcess }))
vi.mock('../ipc/command-path/command-path-resolver', async (importOriginal) => ({
  ...(await importOriginal<typeof CommandPathResolver>()),
  resolveCommandOnLocalPath
}))

const SETTINGS = { disabledTuiAgents: [], agentCmdOverrides: {} }

type ProcessOutput = {
  code: number | null
  signal?: NodeJS.Signals | null
  stdout?: string
  stderr?: string
  timedOut?: boolean
}

let updateResult: ProcessOutput
let versionAfterUpdate: string
let updateGate: Promise<void> | null

function isVersionProbe(args: readonly string[]): boolean {
  return args.length === 1 && args[0] === '--version'
}

function updateCalls() {
  return runProcess.mock.calls.filter(([spec]) => !isVersionProbe(spec.args))
}

describe('runAgentUpdate', () => {
  beforeEach(() => {
    updateResult = { code: 0 }
    versionAfterUpdate = '2.1.320 (Claude Code)\n'
    updateGate = null
    resolveCommandOnLocalPath.mockImplementation(async (command: string) => `/opt/bin/${command}`)
    runProcess.mockImplementation(
      async ({ args }: { args: readonly string[] }): Promise<Required<ProcessOutput>> => {
        if (isVersionProbe(args)) {
          return {
            code: 0,
            signal: null,
            stdout: versionAfterUpdate,
            stderr: '',
            timedOut: false
          }
        }
        await updateGate
        return { signal: null, stdout: '', stderr: '', timedOut: false, ...updateResult }
      }
    )
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('runs the agent self-update through its resolved binary and reports the new version', async () => {
    const outcome = await runAgentUpdate('claude', '2.1.319', SETTINGS)

    expect(outcome).toEqual({ status: 'done', version: '2.1.320' })
    expect(updateCalls()).toHaveLength(1)
    expect(updateCalls()[0][0]).toMatchObject({
      program: '/opt/bin/claude',
      args: ['update'],
      timeoutMs: 300_000,
      terminationBarrier: true
    })
    expect(updateCalls()[0][1]).toBe('tail')
  })

  it('updates an npm install of gemini through the resolved npm into the same prefix', async () => {
    resolveCommandOnLocalPath.mockImplementation(async (command: string) =>
      command === 'npm'
        ? '/usr/local/bin/npm'
        : '/usr/local/lib/node_modules/@google/gemini-cli/dist/index.js'
    )
    versionAfterUpdate = '0.9.1\n'

    const outcome = await runAgentUpdate('gemini', '0.9.0', SETTINGS)

    expect(outcome).toEqual({ status: 'done', version: '0.9.1' })
    expect(updateCalls()).toHaveLength(1)
    expect(updateCalls()[0][0]).toMatchObject({
      program: '/usr/local/bin/npm',
      args: ['install', '-g', '--prefix', '/usr/local', '@google/gemini-cli@latest']
    })
  })

  it('hands back the command without running anything when no step applies to the install', async () => {
    resolveCommandOnLocalPath.mockResolvedValue(
      '/Applications/OpenClaw.app/Contents/MacOS/openclaw'
    )

    const outcome = await runAgentUpdate('openclaw', '1.0.0', SETTINGS)

    expect(outcome).toEqual({
      status: 'manual',
      command: '/Applications/OpenClaw.app/Contents/MacOS/openclaw update'
    })
    expect(runProcess).not.toHaveBeenCalled()
  })

  it('starts one update for back-to-back calls and allows another once it settled', async () => {
    let release = () => {}
    updateGate = new Promise<void>((resolve) => {
      release = resolve
    })

    const first = runAgentUpdate('claude', '2.1.319', SETTINGS)
    const second = runAgentUpdate('claude', '2.1.319', SETTINGS)
    expect(second).toBe(first)
    release()

    expect(await first).toEqual({ status: 'done', version: '2.1.320' })
    expect(updateCalls()).toHaveLength(1)

    await runAgentUpdate('claude', '2.1.319', SETTINGS)
    expect(updateCalls()).toHaveLength(2)
  })

  it('fails when the command succeeds but the installed version did not change', async () => {
    versionAfterUpdate = '2.1.319 (Claude Code)\n'

    expect(await runAgentUpdate('claude', '2.1.319', SETTINGS)).toMatchObject({
      status: 'failed',
      message: expect.stringMatching(/\S/)
    })
  })

  it('fails when the version cannot be read after the update', async () => {
    versionAfterUpdate = 'not a version\n'

    expect(await runAgentUpdate('claude', '2.1.319', SETTINGS)).toMatchObject({
      status: 'failed',
      message: expect.stringMatching(/\S/)
    })
  })

  it('puts the end of the output in the message when the command exits non-zero', async () => {
    updateResult = { code: 1, stdout: 'a'.repeat(600), stderr: 'npm error EACCES\n' }

    expect(await runAgentUpdate('claude', '2.1.319', SETTINGS)).toEqual({
      status: 'failed',
      message: `${'a'.repeat(483)}\nnpm error EACCES`
    })
  })

  it('refuses to act on a Homebrew install it has no update step for', async () => {
    resolveCommandOnLocalPath.mockResolvedValue('/opt/homebrew/Cellar/crush/0.100.0/bin/crush')

    expect(await runAgentUpdate('crush', '0.100.0', SETTINGS)).toMatchObject({
      status: 'failed',
      message: expect.stringMatching(/\S/)
    })
    expect(runProcess).not.toHaveBeenCalled()
  })
})

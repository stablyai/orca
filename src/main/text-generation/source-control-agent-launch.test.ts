import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as RunProcess from '../../shared/child-process/run-process'
import type { ProcessSpec } from '../../shared/child-process/process-spec'
import { POSIX_PROVIDER_SUPERVISOR_SCRIPT } from '../provider-process/provider-process-supervisor'
import { generateCommitMessageFromContext } from './commit-message-text-generation'
import { withPlatform } from './commit-message-text-generation-test-harness'
import { spawnSourceControlAgent } from './source-control-agent-launch'

const { spawnProcessMock } = vi.hoisted(() => ({ spawnProcessMock: vi.fn() }))

vi.mock('../../shared/child-process/run-process', async (importOriginal) => {
  const actual = await importOriginal<typeof RunProcess>()
  spawnProcessMock.mockImplementation(actual.spawnProcess)
  return { ...actual, spawnProcess: spawnProcessMock }
})

function fakeChild(): EventEmitter & { stdin: { on: () => void; end: () => void } } {
  return Object.assign(new EventEmitter(), { stdin: { on: vi.fn(), end: vi.fn() } })
}

function lastSpawnSpec(): ProcessSpec {
  return spawnProcessMock.mock.calls.at(-1)![0]
}

function decodedSupervisorSpec(spec: ProcessSpec): Record<string, unknown> {
  return JSON.parse(Buffer.from(spec.env!.ORCA_PROVIDER_SUPERVISOR_SPEC!, 'base64').toString())
}

const folder = mkdtempSync(join(tmpdir(), 'orca-agent-launch-'))
afterAll(() => rmSync(folder, { recursive: true, force: true }))

beforeEach(() => {
  spawnProcessMock.mockClear()
})

describe('spawnSourceControlAgent', () => {
  it.each([
    ['in its own cwd', true, '/work/repo'],
    ['in the process cwd', false, process.cwd()]
  ])('runs a POSIX agent one-shot under the provider supervisor %s', (_, useCwd, cwd) => {
    spawnProcessMock.mockReturnValueOnce(fakeChild())
    const child = withPlatform('linux', () =>
      spawnSourceControlAgent({
        binary: '/opt/agent/claude',
        args: ['-p', '--verbose'],
        cwd: '/work/repo',
        env: { PATH: '/usr/bin', AGENT_TOKEN: 'kept' },
        stdinMode: 'pipe',
        useCwdForNative: useCwd
      })
    )

    const spec = lastSpawnSpec()
    expect(child.supervised).toBe(true)
    expect(spec).toMatchObject({
      program: process.execPath,
      args: ['-e', POSIX_PROVIDER_SUPERVISOR_SCRIPT, '--', '/opt/agent/claude', '-p', '--verbose'],
      cwd,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    expect(spec.env).toMatchObject({ PATH: '/usr/bin', AGENT_TOKEN: 'kept' })
    expect(decodedSupervisorSpec(spec)).toMatchObject({ cwd, lifetime: 'one-shot' })
  })

  it('spawns a Windows agent directly, without a supervisor', () => {
    spawnProcessMock.mockReturnValueOnce(fakeChild())
    const child = withPlatform('win32', () =>
      spawnSourceControlAgent({
        binary: 'C:/tools/agent.exe',
        args: ['--print'],
        env: { PATH: 'C:/tools' },
        stdinMode: 'pipe',
        useCwdForNative: false
      })
    )

    expect(child.supervised).toBeUndefined()
    expect(lastSpawnSpec()).toMatchObject({ program: 'C:/tools/agent.exe', args: ['--print'] })
    expect(lastSpawnSpec().env).not.toHaveProperty('ORCA_PROVIDER_SUPERVISOR_SPEC')
  })
})

describe.runIf(process.platform !== 'win32')('supervised agent processes', () => {
  it('reports a missing agent binary as not found, as a direct spawn does', async () => {
    const missing = join(folder, 'missing-agent')

    await expect(
      generateCommitMessageFromContext(
        { branch: 'main', stagedSummary: 'M README.md', stagedPatch: '+test' },
        { agentId: 'custom', model: '', customAgentCommand: `"${missing}"` },
        { kind: 'local', cwd: folder }
      )
    ).resolves.toEqual({
      success: false,
      error: `${missing} not found on PATH. Install ${missing} to use AI commit messages.`
    })
  })

  it('reports an agent that cannot be executed as failing to start, as a direct spawn does', async () => {
    const agent = join(folder, 'not-executable-agent')
    writeFileSync(agent, '#!/bin/sh\necho never\n', { mode: 0o644 })

    await expect(
      generateCommitMessageFromContext(
        { branch: 'main', stagedSummary: 'M README.md', stagedPatch: '+test' },
        { agentId: 'custom', model: '', customAgentCommand: `"${agent}"` },
        { kind: 'local', cwd: folder }
      )
    ).resolves.toEqual({
      success: false,
      error: `${agent} failed to start. Check the agent command in Settings and try again.`
    })
  })

  it.each([
    // Only macOS throws ENOEXEC; glibc's execvp hands such a file to /bin/sh, direct or supervised.
    ...(process.platform === 'darwin'
      ? [['an executable that is not a program', 'garbage', (path: string) => path] as const]
      : []),
    ['a path through a file', 'file', (path: string) => join(path, 'agent')] as const
  ])('reports %s as not startable, as a direct spawn does', async (_, name, commandFor) => {
    const file = join(folder, name)
    writeFileSync(file, Buffer.from([0, 1, 2, 3]), { mode: 0o755 })
    const command = commandFor(file)

    await expect(
      generateCommitMessageFromContext(
        { branch: 'main', stagedSummary: 'M README.md', stagedPatch: '+test' },
        { agentId: 'custom', model: '', customAgentCommand: `"${command}"` },
        { kind: 'local', cwd: folder }
      )
    ).resolves.toEqual({
      success: false,
      error: `${command} could not be started. Check the agent command in Settings and try again.`
    })
  })

  // Electron prints startup warnings (a bad NODE_EXTRA_CA_CERTS); Node's debug log stands in here.
  it('reads a missing binary as not found past the runtime own stderr output', async () => {
    const missing = join(folder, 'missing-behind-warning')

    await expect(
      generateCommitMessageFromContext(
        { branch: 'main', stagedSummary: 'M README.md', stagedPatch: '+test' },
        { agentId: 'custom', model: '', customAgentCommand: `"${missing}"` },
        {
          kind: 'local',
          cwd: folder,
          env: { ...process.env, NODE_DEBUG: 'child_process' }
        }
      )
    ).resolves.toEqual({
      success: false,
      error: `${missing} not found on PATH. Install ${missing} to use AI commit messages.`
    })
  })

  it('passes the stdin end through so the agent can answer its request', async () => {
    const agent = join(folder, 'echo-agent.cjs')
    writeFileSync(
      agent,
      `let prompt = ''
process.stdin.on('data', (chunk) => (prompt += chunk))
process.stdin.on('end', () => setTimeout(() => console.log(prompt.includes('README') ? 'Update README' : 'no prompt'), 1200))
`
    )

    await expect(
      generateCommitMessageFromContext(
        { branch: 'main', stagedSummary: 'M README.md', stagedPatch: '+test' },
        { agentId: 'custom', model: '', customAgentCommand: `"${process.execPath}" "${agent}"` },
        { kind: 'local', cwd: folder }
      )
    ).resolves.toMatchObject({ success: true, message: 'Update README' })
    expect(lastSpawnSpec().program).toBe(process.execPath)
    expect(decodedSupervisorSpec(lastSpawnSpec())).toMatchObject({ lifetime: 'one-shot' })
  })
})

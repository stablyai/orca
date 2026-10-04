import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDshStructuredLaunchResolver } from './dsh-structured-launch-resolution'
import { openTestAgentSessionRecordStore } from '../runtime/agent-session-record-store-test-harness'
import { closeTestJournalHostDatabase } from '../native-chat/agent-session-journal/journal-host-database-test-support'
import { runProcess } from '../../shared/child-process/run-process'

vi.mock('../../shared/child-process/run-process', () => ({ runProcess: vi.fn() }))

const roots: string[] = []
afterEach(() => {
  vi.clearAllMocks()
  for (const root of roots.splice(0)) {
    closeTestJournalHostDatabase(root)
    rmSync(root, { recursive: true, force: true })
  }
})

describe('official ACP resolved launch and runtime pairing', () => {
  it('returns a supported launch and pairs both version probe and provider child with the CLI node', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-launch-pairing-'))
    roots.push(root)
    const bin = join(root, 'cli-bin'),
      cwd = join(root, 'folder'),
      home = join(root, 'dsh-home')
    for (const directory of [bin, cwd, home]) {
      mkdirSync(directory)
    }
    const command = join(bin, process.platform === 'win32' ? 'dsh.cmd' : 'dsh')
    writeFileSync(command, 'fixture', { mode: 0o700 })
    copyFileSync(process.execPath, join(bin, process.platform === 'win32' ? 'node.exe' : 'node'))
    const store = await openTestAgentSessionRecordStore(root)
    await store.reserveOwner({
      sessionId: 'official-launch',
      location: {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: 'folder',
        workspaceKind: 'folder'
      },
      provider: 'dsh-acp',
      accountHome: { variable: 'DSH_HOME', path: home },
      expectedFence: null,
      spawnToken: 'launch-token',
      claimKeyId: 'fixture-key',
      handoffOperationId: null,
      probe: { outcome: 'reservation-unused' },
      operation: {
        callerKey: 'fixture',
        operationId: '1800000000000-00000000000000000000000000000001',
        fingerprint: 'fixture'
      },
      now: 1_800_000_000_000
    })
    vi.mocked(runProcess).mockResolvedValue({
      code: 0,
      signal: null,
      stdout: '0.2.1-alpha.1\n',
      stderr: '',
      timedOut: false,
      outputTruncated: false
    })
    const environment = { PATH: process.env.PATH ?? '', DSH_HOME: join(root, 'wrong-home') }
    const resolveLaunch = createDshStructuredLaunchResolver({
      store,
      resolveWorkspacePath: async () => cwd,
      resolveEnvironment: async () => environment,
      resolveCommand: () => command
    })
    const launch = await resolveLaunch({
      identity: {
        sessionId: 'official-launch',
        workspaceId: 'folder',
        hostId: 'local',
        agent: 'dsh-acp',
        providerHandle: { kind: 'opaque', agent: 'dsh-acp', value: 'pending' }
      },
      fence: 1,
      spawnToken: 'launch-token'
    })
    expect(launch).toMatchObject({
      command,
      args: ['--profile', 'acp'],
      cwd,
      env: { DSH_HOME: home }
    })
    expect(launch.env?.PATH?.split(delimiter)[0]).toBe(bin)
    expect(runProcess).toHaveBeenCalledWith(
      expect.objectContaining({ program: command, args: ['--version'], env: launch.env, cwd })
    )
    expect(environment.DSH_HOME).toBe(join(root, 'wrong-home'))
    expect(environment.PATH).toBe(process.env.PATH ?? '')
  })
})

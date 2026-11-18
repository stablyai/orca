import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DaemonClient } from '../daemon/transport/client/daemon-client'
import type { HostedProviderSpawn } from '../daemon/protocol/daemon-provider-process-protocol'
import { spawnHostedProvider } from '../daemon/server/daemon-provider-spawn'
import { spawnManagedProviderProcess } from './managed-provider-process'
import { installProviderProcessHost } from './provider-process-spawn'

const state = vi.hoisted(() => ({ root: '' }))
vi.mock('../../shared/app-lifecycle/app-environment', () => ({
  getAppEnvironment: () => ({
    getPath: () => state.root,
    getAppPath: () => process.cwd(),
    isPackaged: () => false
  })
}))
vi.mock('../daemon/executable-host/macos/daemon-mac-code-identity', () => ({
  inspectMacProcessCodeIdentity: async () => ({ executablePath: '/host', identity: 'resolved' })
}))

type HostStart = 'ok' | 'no-cwd' | 'lost-reply'

function hostClient(
  spawns: HostedProviderSpawn[],
  cwdOutcome = 'ok',
  start: HostStart = 'ok',
  started: number[] = []
): DaemonClient {
  const identity = { pid: process.pid, providerSpawn: true as const }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the launcher uses only these client methods.
  return {
    getDaemonIdentity: () => identity,
    ensureConnectedWithin: async () => {},
    request: async (type: string, payload: unknown, timeoutMs?: number) => {
      if (type === 'probeProviderCwd') {
        if (cwdOutcome !== 'unanswered') {
          return { outcome: cwdOutcome }
        }
        // Like the real client: a request with no deadline would wait as long as a macOS prompt stays up.
        return new Promise((_resolve, reject) => {
          if (timeoutMs !== undefined) {
            setTimeout(() => reject(new Error('Request timed out')), timeoutMs)
          }
        })
      }
      if (type === 'spawnProvider') {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the launcher under test sends this payload type.
        const launch = payload as HostedProviderSpawn
        spawns.push(launch)
        // The host's own view of the folder can differ from the probe's moments earlier.
        const cwd = start === 'no-cwd' ? join(state.root, 'gone') : launch.cwd
        const result = await spawnHostedProvider({ ...launch, cwd }, true)
        if (start === 'lost-reply' && 'pid' in result) {
          started.push(result.pid)
          throw new Error('Request timed out')
        }
        return result
      }
      return {}
    }
  } as unknown as DaemonClient
}

beforeEach(async () => {
  state.root = await mkdtemp(join(tmpdir(), 'orca-hosted-provider-'))
})
afterEach(async () => {
  await rm(state.root, { recursive: true, force: true })
})

// Each run marks its start, so a test can prove only one CLI ever ran for the turn.
const UPPERCASE_STDIN =
  "require('fs').appendFileSync(process.argv[1], 'run;'); let s=''; process.stdin.on('data', (d) => (s += d)).on('end', () => { process.stdout.write(s.toUpperCase()); process.exitCode = 7 })"

const cliRuns = (): Promise<string> => readFile(join(state.root, 'runs'), 'utf8')

async function runChat(): Promise<{ closed: unknown[]; output: string }> {
  const managed = spawnManagedProviderProcess(
    {
      command: process.execPath,
      cwd: state.root,
      args: ['-e', UPPERCASE_STDIN, join(state.root, 'runs')]
    },
    { site: 'hosted-provider-launch-test', inheritedEnv: process.env }
  )
  let output = ''
  managed.child.stdout.setEncoding('utf8').on('data', (chunk: string) => (output += chunk))
  const closed = new Promise<unknown[]>((resolve) =>
    managed.child.once('close', (...args: unknown[]) => resolve(args))
  )
  await managed.child.ready
  // Input ends only once the CLI runs: its owner allows a short grace after stdin closes.
  await vi.waitFor(() => cliRuns(), { timeout: 10_000, interval: 20 })
  managed.child.stdin.end('chat reply')
  return { closed: await closed, output }
}

describe.runIf(process.platform !== 'win32')('hosted native provider owner', () => {
  it('delivers input, output and the real exit through pipes only this app holds', async () => {
    const spawns: HostedProviderSpawn[] = []
    const verdicts: unknown[] = []
    installProviderProcessHost(
      async () => hostClient(spawns),
      (verdict) => verdicts.push(verdict)
    )
    // A host that kept its pipe copies would hold output open, so close would never arrive.
    await expect(runChat()).resolves.toEqual({ closed: [7, null], output: 'CHAT REPLY' })
    expect(spawns).toHaveLength(1)
    expect(spawns[0]?.args).toContain(process.execPath)
    // A readable verdict is what clears a folder-access notice after access is allowed again.
    expect(verdicts).toEqual([
      expect.objectContaining({ cwd: state.root, cwdReadableByDaemon: true })
    ])
  })

  it('launches here and reports the denial when the host cannot read the folder', async () => {
    const spawns: HostedProviderSpawn[] = []
    const verdicts: unknown[] = []
    installProviderProcessHost(
      async () => hostClient(spawns, 'denied'),
      (verdict) => verdicts.push(verdict)
    )
    await expect(runChat()).resolves.toEqual({ closed: [7, null], output: 'CHAT REPLY' })
    expect(spawns).toHaveLength(0)
    expect(verdicts).toEqual([
      expect.objectContaining({ cwd: state.root, cwdReadableByDaemon: false })
    ])
  })

  it('launches here without a verdict when the host never answers the folder probe', async () => {
    const spawns: HostedProviderSpawn[] = []
    const verdicts: unknown[] = []
    installProviderProcessHost(
      async () => hostClient(spawns, 'unanswered'),
      (verdict) => verdicts.push(verdict)
    )
    await expect(runChat()).resolves.toEqual({ closed: [7, null], output: 'CHAT REPLY' })
    expect(spawns).toHaveLength(0)
    expect(verdicts).toEqual([])
  })

  it('launches here when the host cannot start the owner after a readable probe', async () => {
    const spawns: HostedProviderSpawn[] = []
    installProviderProcessHost(async () => hostClient(spawns, 'ok', 'no-cwd'))
    await expect(runChat()).resolves.toEqual({ closed: [7, null], output: 'CHAT REPLY' })
    expect(spawns).toHaveLength(1)
    await expect(cliRuns()).resolves.toBe('run;')
  })

  it('launches here once when the host started an owner but its reply was lost', async () => {
    const started: number[] = []
    installProviderProcessHost(async () => hostClient([], 'ok', 'lost-reply', started))
    await expect(runChat()).resolves.toEqual({ closed: [7, null], output: 'CHAT REPLY' })
    expect(started).toHaveLength(1)
    // The stranded owner exits at its closed gate, so its CLI never ran.
    await vi.waitFor(() => expect(() => process.kill(started[0]!, 0)).toThrow(), { timeout: 5_000 })
    await expect(cliRuns()).resolves.toBe('run;')
  })
})

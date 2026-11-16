import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ZotzNodeSetupStep } from '../../shared/zotz/zotz-node-setup-contract'
import type { ZotzNodeSetupEnvironment } from './zotz-node-setup-environment'
import { runZotzNodeSetup, type ZotzNodeSetupPhase } from './zotz-node-setup-orchestrator'
import { buildZotzNodeSetupPhases } from './zotz-node-setup-phases'
import type { ZotzProcessResult } from './zotz-process-runner'

type Call = { program: string; args: readonly string[] }

type FakeOverrides = Partial<Omit<ZotzNodeSetupEnvironment, 'exists'>> & {
  exists?: (path: string) => boolean
}

function fakeEnvironment(
  {
    exists = (path) => path === '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
    ...overrides
  }: FakeOverrides,
  answer: (call: Call) => Partial<ZotzProcessResult> = () => ({})
): { environment: ZotzNodeSetupEnvironment; calls: Call[]; files: Map<string, string | Buffer> } {
  const calls: Call[] = []
  const files = new Map<string, string | Buffer>()
  let clock = 0
  const environment: ZotzNodeSetupEnvironment = {
    platform: 'darwin',
    env: {},
    run: async (program, args) => {
      const call = { program, args }
      calls.push(call)
      return { code: 0, stdout: '', stderr: '', ...answer(call) }
    },
    exists: async (path) => exists(path),
    readText: async (path) => {
      const value = files.get(path)
      return typeof value === 'string' ? value : null
    },
    writeFile: async (path, data) => {
      files.set(path, data)
    },
    removeFile: async (path) => {
      files.delete(path)
    },
    isPackaged: true,
    executablePath: '/Applications/Zotz.app/Contents/MacOS/Zotz',
    homeDir: '/Users/hugo',
    userDataPath: '/Users/hugo/Library/Application Support/zotz',
    username: 'hugo',
    port: 6768,
    setupScriptPath: null,
    ensureNetworkExposure: async () => {},
    isKeptAwake: () => true,
    sleep: async (ms) => {
      clock += ms
    },
    now: () => clock,
    tailscaleWaitMs: 60_000,
    ...overrides
  }
  return { environment, calls, files }
}

const runningTailnet = JSON.stringify({
  BackendState: 'Running',
  Self: { TailscaleIPs: ['100.88.1.2', 'fd7a:115c:a1e0::1'] }
})

const statuses = (result: { steps: ZotzNodeSetupStep[] }) =>
  Object.fromEntries(result.steps.map((step) => [step.id, step.status]))

describe('runZotzNodeSetup', () => {
  it('runs phases in order, isolates a failing phase and fails steps a phase left unreported', async () => {
    const order: string[] = []
    const progress: ZotzNodeSetupStep[][] = []
    const phases: ZotzNodeSetupPhase[] = [
      {
        steps: ['tailscale'],
        run: async (context) => {
          order.push('tailscale')
          context.setTailscaleIp('100.88.1.2')
          return { tailscale: { status: 'done' } }
        }
      },
      {
        steps: ['power', 'firewall'],
        run: async () => {
          order.push('system')
          throw new Error('boom')
        }
      },
      {
        steps: ['keepAwake', 'networkExposure'],
        run: async () => {
          order.push('rest')
          return { keepAwake: { status: 'skipped', detail: 'why' } }
        }
      }
    ]
    const result = await runZotzNodeSetup(phases, (steps) => progress.push(steps))

    expect(order).toEqual(['tailscale', 'system', 'rest'])
    expect(result.tailscaleIp).toBe('100.88.1.2')
    expect(result.steps).toEqual([
      { id: 'tailscale', status: 'done' },
      { id: 'power', status: 'failed', detail: 'boom' },
      { id: 'firewall', status: 'failed', detail: 'boom' },
      { id: 'keepAwake', status: 'skipped', detail: 'why' },
      { id: 'networkExposure', status: 'failed', detail: 'no result reported' }
    ])
    expect(progress[0]?.map((step) => step.status)).toEqual([
      'running',
      'pending',
      'pending',
      'pending',
      'pending'
    ])
  })
})

describe('Tailscale phase', () => {
  it('installs when missing, asks for login once and waits for a live tailnet address', async () => {
    let installed = false
    let statusReads = 0
    const { environment, calls } = fakeEnvironment(
      {
        exists: (path) =>
          path === '/opt/homebrew/bin/brew' ||
          (installed && path === '/Applications/Tailscale.app/Contents/MacOS/Tailscale')
      },
      ({ program, args }) => {
        if (program === '/opt/homebrew/bin/brew') {
          installed = true
          return {}
        }
        if (args[0] === 'status') {
          statusReads += 1
          return statusReads < 3
            ? { code: 1, stdout: JSON.stringify({ BackendState: 'NeedsLogin' }) }
            : { stdout: runningTailnet }
        }
        return {}
      }
    )
    const result = await runZotzNodeSetup([buildZotzNodeSetupPhases(environment)[0]!], () => {})

    expect(result.steps[0]).toEqual({ id: 'tailscale', status: 'done', detail: '100.88.1.2' })
    expect(result.tailscaleIp).toBe('100.88.1.2')
    expect(calls.filter((call) => call.program === '/opt/homebrew/bin/brew')).toHaveLength(1)
    expect(calls.filter((call) => call.args[0] === 'login')).toHaveLength(1)
  })

  it('gives up with the login page when nobody logs in before the deadline', async () => {
    const { environment } = fakeEnvironment({}, ({ args }) =>
      args[0] === 'status'
        ? {
            stdout: JSON.stringify({
              BackendState: 'NeedsLogin',
              AuthURL: 'https://login.tailscale.com/a/abc'
            })
          }
        : {}
    )
    const result = await runZotzNodeSetup([buildZotzNodeSetupPhases(environment)[0]!], () => {})
    expect(result.steps[0]).toMatchObject({
      status: 'failed',
      url: 'https://login.tailscale.com/a/abc'
    })
    expect(result.tailscaleIp).toBeNull()
  })
})

describe('Windows server setup', () => {
  const windows = {
    platform: 'win32' as const,
    env: { SystemRoot: 'C:\\Windows', USERDOMAIN: 'MSI' },
    exists: (path: string) => path === 'C:\\Program Files\\Tailscale\\tailscale.exe',
    executablePath: 'C:\\Users\\zotz\\AppData\\Local\\Programs\\zotz\\Zotz.exe',
    userDataPath: 'C:\\Users\\zotz\\AppData\\Roaming\\zotz',
    username: 'zotz',
    setupScriptPath:
      'C:\\Users\\zotz\\AppData\\Local\\Programs\\zotz\\resources\\zotz\\zotz-node-setup.ps1'
  }

  it('applies every admin step through one UAC prompt and reports the script result per step', async () => {
    const resultPath = join(windows.userDataPath, 'zotz-node-setup-result.json')
    const holder: { files?: Map<string, string | Buffer> } = {}
    const { environment, calls, files } = fakeEnvironment(windows, ({ program, args }) => {
      if (program.endsWith('tailscale.exe')) {
        return { stdout: runningTailnet }
      }
      if (program.endsWith('powershell.exe')) {
        expect(String(args.at(-1))).toContain(resultPath)
        holder.files?.set(
          resultPath,
          JSON.stringify({
            version: 1,
            steps: [
              { id: 'power', status: 'done', detail: 'AC' },
              { id: 'windowsUpdate', status: 'done' },
              { id: 'ssh', status: 'failed', detail: 'offline' },
              { id: 'firewall', status: 'done' },
              { id: 'autostart', status: 'done' }
            ]
          })
        )
        return { stdout: '{"launched":true,"exitCode":1}' }
      }
      return {}
    })
    holder.files = files
    const result = await runZotzNodeSetup(buildZotzNodeSetupPhases(environment), () => {})

    const elevations = calls.filter((call) => String(call.args.at(-1)).includes('-Verb RunAs'))
    expect(elevations).toHaveLength(1)
    const script = String(elevations[0]!.args.at(-1))
    expect(script).toContain('-ExecutionPolicy')
    expect(script).toContain('RemoteSigned')
    expect(script).toContain('-TaskName')
    expect(statuses(result)).toEqual({
      tailscale: 'done',
      power: 'done',
      windowsUpdate: 'done',
      ssh: 'failed',
      firewall: 'done',
      autostart: 'done',
      keepAwake: 'done',
      networkExposure: 'done',
      autologon: 'skipped'
    })
    const taskXml = files.get(join(windows.userDataPath, 'zotz-server-task.xml'))
    if (!Buffer.isBuffer(taskXml)) {
      throw new Error('the task XML must be written as UTF-16 bytes')
    }
    const xml = taskXml.subarray(2).toString('utf16le')
    expect(xml).toContain(`<Command>${windows.executablePath}</Command>`)
    expect(xml).toContain('<Arguments>"--zotz-node-autostart"</Arguments>')
    expect(xml).toContain('<UserId>MSI\\zotz</UserId>')
  })

  it('marks every admin step failed when the UAC prompt is declined', async () => {
    const { environment } = fakeEnvironment(windows, ({ program }) =>
      program.endsWith('tailscale.exe')
        ? { stdout: runningTailnet }
        : program.endsWith('powershell.exe')
          ? { stdout: '{"launched":false,"nativeErrorCode":1223,"message":"cancelled"}' }
          : {}
    )
    const result = await runZotzNodeSetup(buildZotzNodeSetupPhases(environment), () => {})
    for (const id of ['power', 'windowsUpdate', 'ssh', 'firewall', 'autostart']) {
      expect(result.steps.find((step) => step.id === id)).toEqual({
        id,
        status: 'failed',
        detail: 'administrator permission was declined'
      })
    }
    expect(statuses(result).networkExposure).toBe('done')
  })
})

describe('macOS server setup', () => {
  it('skips the admin prompt when AC sleep is already off and writes the LaunchAgent', async () => {
    const pmset =
      'Custom battery settings:\nBattery Power:\n sleep 1\nAC Power:\n sleep 0\n disksleep 0\n'
    const exposure = vi.fn(async () => {})
    const { environment, calls, files } = fakeEnvironment(
      { ensureNetworkExposure: exposure },
      ({ program, args }) =>
        program === '/usr/bin/pmset'
          ? { stdout: pmset }
          : args[0] === 'status'
            ? { stdout: runningTailnet }
            : {}
    )
    const result = await runZotzNodeSetup(buildZotzNodeSetupPhases(environment), () => {})

    expect(calls.some((call) => call.program === '/usr/bin/osascript')).toBe(false)
    expect(statuses(result)).toEqual({
      tailscale: 'done',
      power: 'done',
      firewall: 'skipped',
      autostart: 'done',
      keepAwake: 'done',
      networkExposure: 'done'
    })
    expect(exposure).toHaveBeenCalledTimes(1)
    const plist = String(
      files.get('/Users/hugo/Library/LaunchAgents/dev.hugorodriguez.zotz.server.plist')
    )
    expect(plist).toContain('<string>--zotz-node-autostart</string>')
    expect(plist).toContain('<key>SuccessfulExit</key>\n    <false/>')
  })
})

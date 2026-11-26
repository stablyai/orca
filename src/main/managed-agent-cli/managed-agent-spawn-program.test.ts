import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { withOmpDraftCleanup } from '../../shared/agent-launch/startup/omp-draft-launch'
import { withFreshOmpLaunch } from '../../shared/agent-launch/startup/omp-fresh-launch'
import { buildAgentStartupPlan } from '../../shared/agent-launch/startup/tui-agent-startup'
import { detectInstalledAgentInventory } from '../preflight/installed-agent-detection'
import { selectTerminalAgentProgram } from '../preflight/agent-command-detection'
import { alignManagedAgentLaunchAtSpawn } from './managed-agent-spawn-program'

const detection = vi.hoisted(() => ({ path: '' }))
vi.mock(import('../preflight/agent-command-detection'), async (importOriginal) => ({
  ...(await importOriginal()),
  selectTerminalAgentProgram: vi.fn()
}))
vi.mock('../ipc/preflight/preflight-local-env', () => ({
  buildLocalPreflightEnv: () => ({ Path: detection.path })
}))
vi.mock('../ipc/command-path/command-path-directory-worker-client', () => ({
  readDetectionDirectoryViaWorker: async () => null
}))
vi.mock('../orca-profiles/profile-storage-paths', () => ({
  getProfileUserDataPath: () => (process.platform === 'win32' ? 'C:\\data\\orca' : '/data/orca')
}))
const ompGuard = 'printenv ORCA_OMP_FRESH_CONFIG >/dev/null && test -f "$ORCA_OMP_FRESH_CONFIG"'
const ompFailure =
  "printf '%s\\n' 'Orca: fresh OMP settings are unavailable on this host. Restart the terminal after updating Orca.' >&2"

async function spawnLegacyOmp(launchCommand: string): Promise<string | undefined> {
  vi.mocked(selectTerminalAgentProgram).mockResolvedValueOnce({
    program: 'omp',
    result: { kind: 'by-name', path: '/usr/local/bin/omp' }
  })
  return (await alignManagedAgentLaunchAtSpawn({ launchCommand, restoring: true }, 'posix')).command
}

it.each([
  {
    platform: 'linux',
    shell: 'posix',
    executable: '/opt/Hermes User/bin/hermes'
  },
  {
    platform: 'win32',
    shell: 'powershell',
    executable: 'C:\\Hermes User\\hermes.exe'
  }
] as const)(
  'keeps the $shell Hermes prompt wrapper around the selected executable',
  async ({ platform, shell, executable }) => {
    const plan = buildAgentStartupPlan({
      agent: 'hermes',
      platform,
      shell,
      prompt: 'Hello Hermes',
      cmdOverrides: {},
      agentArgs: '--verbose'
    })
    if (!plan) {
      throw new Error('Expected a Hermes plan')
    }
    vi.mocked(selectTerminalAgentProgram).mockResolvedValueOnce({
      program: 'hermes',
      result: { kind: 'full-path', path: executable }
    })
    const result = await alignManagedAgentLaunchAtSpawn({ ...plan, launchAgent: 'hermes' }, shell)
    expect(result.launchConfig?.selectedExecutable).toBe(executable)
    const command = result.command ?? ''
    if (shell === 'posix') {
      expect(command).toMatch(/^sh -c /)
      const bytes = Array.from(command.matchAll(/\\0([0-7]{3})/g), ([, octal]) =>
        Number.parseInt(octal, 8)
      )
      expect(Buffer.from(bytes).toString('utf8')).toBe(
        "'/opt/Hermes User/bin/hermes' 'chat' \"--query=${__orca_hermes_startup_query}\" '--verbose' '--tui'"
      )
    } else {
      const encoded = /^powershell\.exe -NoProfile -EncodedCommand ([A-Za-z0-9+/=]+)$/.exec(
        command
      )?.[1]
      expect(encoded).toBeDefined()
      expect(Buffer.from(encoded ?? '', 'base64').toString('utf16le')).toMatch(
        /& 'C:\\Hermes User\\hermes\.exe' 'chat' "--query=\$orcaHermesNativeQuery" '--verbose' '--tui'$/
      )
    }
  }
)

it('delivers a POSIX Codex resume unchanged over SSH from Windows', async () => {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')
  if (!original) {
    throw new Error('Expected a platform descriptor')
  }
  Object.defineProperty(process, 'platform', { value: 'win32' })
  try {
    const launchCommand = "cd '/home/u/proj' && codex resume abc"
    const launchConfig = {
      agentCommand: 'codex',
      agentArgs: '',
      agentEnv: {},
      commandProvenance: 'generated' as const
    }
    expect(
      await alignManagedAgentLaunchAtSpawn(
        { launchCommand, launchConfig, launchAgent: 'codex', sshTarget: true, restoring: true },
        'powershell'
      )
    ).toEqual({ command: "cd '/home/u/proj' && codex resume abc", launchConfig })
  } finally {
    Object.defineProperty(process, 'platform', original)
  }
})

it.runIf(process.platform === 'win32')(
  'uses the PATH directory spelling and on-disk executable spelling for quoted PowerShell paths',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orca claude path '))
    const pathEntry = join(dirname(dir), basename(dir).toUpperCase())
    const bin = join(dir, 'claude.eXe')
    try {
      await writeFile(bin, '')
      detection.path = `"${pathEntry}"`
      const inventory = await detectInstalledAgentInventory()
      const plan = buildAgentStartupPlan({
        agent: 'claude',
        platform: 'win32',
        shell: 'powershell',
        prompt: '',
        agentArgs: '--verbose',
        allowEmptyPromptLaunch: true,
        cmdOverrides: {},
        managedAgentCommands: inventory.outsidePath
      })
      expect(plan?.launchCommand).toBe(`& '${join(pathEntry, 'claude.eXe')}' '--verbose'`)

      detection.path += `;${dir}`
      expect((await detectInstalledAgentInventory()).outsidePath?.claude).toBeUndefined()
    } finally {
      detection.path = ''
      await rm(dir, { recursive: true, force: true })
    }
  }
)

it.skipIf(process.platform === 'win32')(
  'rewrites a saved executable inside the OMP guard',
  async () => {
    const guard = `${ompGuard} || ${ompFailure}; ${ompGuard} && `
    const suffix = ` --config "$ORCA_OMP_FRESH_CONFIG" 'prompt'`
    const saved = `${guard}'/data/orca/agent-runtimes/omp/1.0/bin/omp'${suffix}`
    expect(await spawnLegacyOmp(saved)).toBe(`${guard}omp${suffix}`)
    expect(await spawnLegacyOmp(withOmpDraftCleanup(saved, 'posix'))).toBe(
      withOmpDraftCleanup(`${guard}omp${suffix}`, 'posix')
    )
  }
)

it.skipIf(process.platform === 'win32')(
  'rewrites the OMP executable with a long prompt',
  async () => {
    const guard = `${ompGuard} || ${ompFailure}; ${ompGuard} && `
    const prompt = ` '${'x'.repeat(5_000)}'`
    const command = withFreshOmpLaunch(
      "'/data/orca/agent-runtimes/omp/1.0/bin/omp'",
      'posix',
      prompt
    )
    expect(await spawnLegacyOmp(command)).toBe(
      `${guard}omp --config "$ORCA_OMP_FRESH_CONFIG"${prompt}`
    )
  }
)

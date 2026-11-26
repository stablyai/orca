import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { withOmpDraftCleanup } from '../../shared/agent-launch/startup/omp-draft-launch'
import { withFreshOmpLaunch } from '../../shared/agent-launch/startup/omp-fresh-launch'
import { buildAgentStartupPlan } from '../../shared/agent-launch/startup/tui-agent-startup'
import { detectInstalledAgentInventory } from '../preflight/installed-agent-detection'
import { alignManagedAgentLaunchAtSpawn } from './managed-agent-spawn-program'

const detection = vi.hoisted(() => ({ path: '' }))
vi.mock('../ipc/preflight/preflight-local-env', () => ({
  buildLocalPreflightEnv: () => ({ Path: detection.path })
}))
vi.mock('../orca-profiles/profile-storage-paths', () => ({
  getProfileUserDataPath: () => (process.platform === 'win32' ? 'C:\\data\\orca' : '/data/orca')
}))
const ompGuard = 'printenv ORCA_OMP_FRESH_CONFIG >/dev/null && test -f "$ORCA_OMP_FRESH_CONFIG"'
const ompFailure =
  "printf '%s\\n' 'Orca: fresh OMP settings are unavailable on this host. Restart the terminal after updating Orca.' >&2"

const spawn = (launchCommand: string) =>
  alignManagedAgentLaunchAtSpawn({ launchCommand, sshTarget: true }, 'posix')

it.runIf(process.platform === 'win32')(
  'uses the absolute Claude path in PowerShell when its directory is quoted on PATH',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orca claude path '))
    const bin = join(dir, 'claude.exe')
    try {
      await writeFile(bin, '')
      detection.path = `"${dir}"`
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
      expect(plan?.launchCommand).toBe(`& '${bin}' '--verbose'`)

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
    expect(await spawn(saved)).toBe(`${guard}omp${suffix}`)
    expect(await spawn(withOmpDraftCleanup(saved, 'posix'))).toBe(
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
    expect(await spawn(command)).toBe(`${guard}omp --config "$ORCA_OMP_FRESH_CONFIG"${prompt}`)
  }
)

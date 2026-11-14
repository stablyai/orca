import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '@orca/process-host'
import { ORCAD_CLI_ENTRY_FILENAME } from '../../../shared/orcad-artifacts'
import { getOrcadCliLauncherPath, prepareOrcadCliLauncher } from './orcad-cli-launcher'

const roots = vi.hoisted(() => ({ install: '', profile: '' }))
vi.mock('../host-runtime/orcad-app-paths', () => ({
  resolveOrcadInstallRoot: () => roots.install,
  resolveUserDataPath: () => roots.profile
}))

let directory = ''
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-node-cli-'))
  roots.install = join(directory, "server ' slot")
  roots.profile = join(directory, "profile ' data")
})

afterEach(async () => {
  Object.defineProperty(process, 'platform', platformDescriptor)
  await rm(directory, { recursive: true, force: true })
})

async function writeCli(): Promise<void> {
  const path = join(roots.install, ...ORCAD_CLI_ENTRY_FILENAME.split('/'))
  await mkdir(dirname(path), { recursive: true })
  await writeFile(
    path,
    'console.log(JSON.stringify({profile:process.env.ORCA_USER_DATA_PATH, args:process.argv.slice(2), electron:process.env.ELECTRON_RUN_AS_NODE}))'
  )
}

describe('orcad profile CLI launcher', () => {
  it.skipIf(process.platform === 'win32')(
    'launches pinned Node with intact arguments and the execution host profile',
    async () => {
      await writeCli()
      await prepareOrcadCliLauncher()
      const launcher = getOrcadCliLauncherPath()
      expect(launcher).toBe(join(roots.profile, 'cli', 'bin', 'orca'))
      if (!launcher) {
        throw new Error('CLI launcher is missing')
      }
      const args = ['orchestration', 'send', 'a body\nwith "quotes" and $HOME']
      const launchers =
        process.platform === 'linux' ? [launcher, join(dirname(launcher), 'orca-ide')] : [launcher]
      for (const program of launchers) {
        const result = await runProcess({
          program,
          args,
          env: {
            ...process.env,
            ORCA_USER_DATA_PATH: '/another/owner',
            ELECTRON_RUN_AS_NODE: '1',
            NODE_OPTIONS: '--require /missing/inherited/preload'
          },
          timeoutMs: 5000
        })
        expect(result.code).toBe(0)
        expect(JSON.parse(result.stdout)).toEqual({ profile: roots.profile, args })
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    "passes a person's own Orca settings through, adding only the profile",
    async () => {
      const path = join(roots.install, ...ORCAD_CLI_ENTRY_FILENAME.split('/'))
      await mkdir(dirname(path), { recursive: true })
      await writeFile(
        path,
        "console.log(JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('ORCA_')))))"
      )
      await prepareOrcadCliLauncher()
      const result = await runProcess({
        program: getOrcadCliLauncherPath()!,
        args: ['status'],
        env: {
          PATH: process.env.PATH,
          ORCA_ENVIRONMENT: 'other-server',
          ORCA_PAIRING_CODE: 'other-pairing'
        },
        timeoutMs: 5000
      })
      expect(result.code).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual({
        ORCA_USER_DATA_PATH: roots.profile,
        ORCA_ENVIRONMENT: 'other-server',
        ORCA_PAIRING_CODE: 'other-pairing'
      })
    }
  )
})

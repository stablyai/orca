import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installServeService, uninstallServeService, type ServeServiceDeps } from './serve-service'
import { resolveServiceCommand } from '../runtime/serve-app-launcher'
import { serveSupervisorBrakePath } from '../runtime/serve-supervisor-brake'

describe('orca serve service', () => {
  let home: string
  let bin: string
  let calls: string[]

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'orca-serve-service-'))
    bin = join(home, 'bin')
    await mkdir(bin)
    await writeFile(join(bin, 'orca'), '#!/bin/sh\n')
    await chmod(join(bin, 'orca'), 0o755)
    await writeFile(join(bin, 'orca-ide'), '#!/bin/sh\n')
    await chmod(join(bin, 'orca-ide'), 0o755)
    calls = []
  })

  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  const deps = (platform: NodeJS.Platform): ServeServiceDeps => ({
    platform,
    env: {
      PATH: `/nonexistent:${bin}`,
      ORCA_USER_DATA_PATH: join(home, 'profile'),
      ELECTRON_RUN_AS_NODE: '1'
    },
    homeDir: home,
    uid: 501,
    run: async (program, args) => {
      const line = [program, ...args].join(' ')
      calls.push(line)
      return { code: 0, out: '' }
    }
  })

  it('installs and loads a LaunchAgent, clearing an old give-up', async () => {
    await mkdir(join(home, 'profile'))
    await writeFile(serveSupervisorBrakePath(join(home, 'profile')), '{}')
    const result = await installServeService({ command: null, dryRun: false }, deps('darwin'))
    const unitPath = String(result.unitPath)
    expect(await readFile(unitPath, 'utf8')).toContain(`<string>${join(bin, 'orca')}</string>`)
    expect(calls).toEqual([
      expect.stringMatching(/^launchctl bootout gui\/501\/com\.stablyai\.orca\.serve\./),
      `launchctl bootstrap gui/501 ${unitPath}`
    ])
    expect(existsSync(serveSupervisorBrakePath(join(home, 'profile')))).toBe(false)
  })

  it('uninstalls by stopping the service and removing the unit', async () => {
    const d = deps('linux')
    const result = await installServeService({ command: null, dryRun: false }, d)
    calls = []
    await expect(uninstallServeService(d)).resolves.toMatchObject({ removed: true })
    expect(existsSync(String(result.unitPath))).toBe(false)
    expect(calls).toEqual([
      `systemctl --user disable --now ${String(result.name)}`,
      'systemctl --user daemon-reload'
    ])
  })

  it('skips a profile launcher and refuses a bare Linux orca', async () => {
    const scoped = join(home, 'profile', 'cli', 'bin')
    await mkdir(scoped, { recursive: true })
    await writeFile(join(scoped, 'orca'), '#!/bin/sh\n')
    await chmod(join(scoped, 'orca'), 0o755)
    expect(
      resolveServiceCommand(null, {
        platform: 'darwin',
        env: { PATH: `${scoped}:${bin}`, ORCA_USER_DATA_PATH: join(home, 'profile') }
      })
    ).toBe(join(bin, 'orca'))
    // Linux takes only orca-ide, never a bare `orca` (often the screen reader).
    const onlyOrca = join(home, 'only-orca')
    await mkdir(onlyOrca)
    await writeFile(join(onlyOrca, 'orca'), '#!/bin/sh\n')
    await chmod(join(onlyOrca, 'orca'), 0o755)
    expect(() =>
      resolveServiceCommand(null, {
        platform: 'linux',
        env: { PATH: onlyOrca, ORCA_USER_DATA_PATH: join(home, 'profile') }
      })
    ).toThrow(/PATH/)
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type * as NodeOs from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { homedirMock } = vi.hoisted(() => ({ homedirMock: vi.fn<() => string>() }))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os')
  return { ...actual, homedir: homedirMock }
})

import { kimiHookService } from './hook-service'
import { buildManagedKimiHooksBlock } from './kimi-hook-config-toml'
import { localDiskSftp } from '../agent-hooks/installation/remote/local-disk-sftp.test-fixture'

// #49505: a re-serialized config holds Orca's hooks as an inline array.
describe('Kimi hook install beside an inline hooks array', () => {
  let home: string
  let configPath: string
  let command: string
  let inline: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'orca-kimi-hooks-'))
    mkdirSync(join(home, '.kimi-code'))
    configPath = join(home, '.kimi-code', 'config.toml')
    homedirMock.mockReturnValue(home)
    vi.stubEnv('KIMI_CODE_HOME', '')
    // Forward slashes keep Windows temp paths free of TOML escape sequences.
    command = `sh '${home.replaceAll('\\', '/')}/.orca/agent-hooks/kimi-hook.sh'`
    inline = `default_model = "k"\nhooks = [{ event = "Stop", command = "${command}" }]\n`
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(home, { recursive: true, force: true })
  })

  it('writes nothing, locally or remotely', async () => {
    writeFileSync(configPath, inline)
    expect(kimiHookService.install().state).toBe('error')
    expect((await kimiHookService.installRemote(localDiskSftp(), home)).state).toBe('error')
    expect(readFileSync(configPath, 'utf-8')).toBe(inline)
    expect(existsSync(join(home, '.orca'))).toBe(false)
  })

  it('drops the block an older install appended, locally and remotely', async () => {
    const broken = `${inline}\n${buildManagedKimiHooksBlock(command)}\n`
    writeFileSync(configPath, broken)
    expect(kimiHookService.install().state).toBe('error')
    expect(readFileSync(configPath, 'utf-8')).toBe(inline)
    writeFileSync(configPath, broken)
    expect((await kimiHookService.installRemote(localDiskSftp(), home)).state).toBe('error')
    expect(readFileSync(configPath, 'utf-8')).toBe(inline)
  })
})

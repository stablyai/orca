import { readFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { Store } from '../../../persistence'
import type { HerdrHostTransport } from './herdr-runtime-contract'
import { HerdrCliHostTransport } from './herdr-cli-session'
import { HerdrSocketTransport } from './herdr-socket-transport'
import { HerdrSshHostTransport } from './herdr-ssh-session'
import { createLocalHerdrPtyProvider, createSshHerdrPtyProvider } from './herdr-provider-factory'
import type { SshConnection } from '../../../ssh/ssh-connection'

function makeStore(settings: ReturnType<typeof getDefaultSettings>): Store {
  return { getSettings: () => settings } as unknown as Store
}

type TestSettings = ReturnType<typeof getDefaultSettings>

function localTransport(settings: TestSettings): HerdrHostTransport {
  const provider = createLocalHerdrPtyProvider(undefined, makeStore(settings))
  const transportForTarget = (
    provider as unknown as {
      transportForTarget(target: { identity: { hostId: string } }): HerdrHostTransport
    }
  ).transportForTarget
  return transportForTarget({ identity: { hostId: 'local' } })
}

describe('createLocalHerdrPtyProvider stock routing', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    delete process.env.HERDR_TEST_LEAK
  })

  it('routes the herdr backend to the stock socket transport by default', () => {
    const settings: TestSettings = {
      ...getDefaultSettings('/tmp'),
      terminalBackendDefault: 'herdr'
    }
    expect(localTransport(settings)).toBeInstanceOf(HerdrSocketTransport)
  })

  it('routes the herdr backend to the stock socket transport when the runtime is stock', () => {
    const settings: TestSettings = {
      ...getDefaultSettings('/tmp'),
      terminalBackendDefault: 'herdr',
      herdrSessionName: 'shared-name'
    }
    const transport = localTransport(settings)
    expect(transport).toBeInstanceOf(HerdrSocketTransport)

    const options = (
      transport as unknown as {
        options: {
          sessionName: string
          serverCommandFor(sessionName: string): {
            file: string
            args: string[]
            env: NodeJS.ProcessEnv
          }
        }
      }
    ).options
    expect(options.sessionName).toBe('shared-name')

    process.env.HERDR_TEST_LEAK = 'must-be-stripped'
    const serverCommand = options.serverCommandFor('mysession')
    expect(serverCommand.file).toBe('herdr')
    expect(serverCommand.args).toEqual(['--session', 'mysession', 'server'])
    expect(serverCommand.env.HERDR_TEST_LEAK).toBeUndefined()
    expect(serverCommand.env.HERDR_SESSION).toBeUndefined()
  })

  it('falls back to the stock socket transport for a non-herdr backend', () => {
    const settings: TestSettings = { ...getDefaultSettings('/tmp') }
    expect(localTransport(settings)).toBeInstanceOf(HerdrSocketTransport)
  })
})

describe('createSshHerdrPtyProvider', () => {
  it('routes system SSH through herdr --remote on the Orca host', () => {
    const settings: TestSettings = {
      ...getDefaultSettings('/tmp'),
      terminalBackendDefault: 'herdr'
    }
    const connection = {
      getTarget: () => ({
        id: 'box',
        label: 'box',
        host: 'box.example',
        port: 22,
        username: 'ada',
        configHost: 'workbox',
        source: 'ssh-config' as const
      }),
      getSystemSshResolvedConfig: () => ({ hostname: 'box.example', user: 'ada', port: 22 }),
      usesSystemSshTransport: () => true
    } as unknown as SshConnection
    const provider = createSshHerdrPtyProvider(undefined, makeStore(settings), connection, 'box')
    const transport = (
      provider as unknown as {
        transportForTarget(): HerdrHostTransport
      }
    ).transportForTarget()
    expect(transport).toBeInstanceOf(HerdrCliHostTransport)
    const options = (
      transport as unknown as {
        options: {
          commandFor(args: string[]): { file: string; args: string[]; env?: NodeJS.ProcessEnv }
          serverCommandFor(sessionName: string): {
            file: string
            args: string[]
            env?: NodeJS.ProcessEnv
          }
        }
      }
    ).options
    const command = options.commandFor(['workspace', 'list'])
    expect(command.args.slice(0, 2)).toEqual(['--remote', 'workbox'])
    expect(command.env?.HERDR_CONFIG_PATH).toBeTruthy()
    expect(readFileSync(command.env?.HERDR_CONFIG_PATH ?? '', 'utf8')).toContain(
      'manage_ssh_config = false'
    )
    const shimDir = command.env?.PATH?.split(delimiter)[0]
    expect(shimDir).toContain('orca-herdr-remote')
    if (process.platform !== 'win32') {
      const shim = readFileSync(join(shimDir ?? '', 'ssh'), 'utf8')
      expect(shim).toContain('ControlMaster=no')
      expect(shim).toContain('ControlPath=')
    }
    expect(options.serverCommandFor('orca').args).toEqual([
      '--remote',
      'workbox',
      '--handoff',
      '--session',
      'orca',
      'server'
    ])
  })

  it('execs over the live connection when the host is ssh2-only', () => {
    const settings: TestSettings = { ...getDefaultSettings('/tmp') }
    const connection = {
      getTarget: () => ({
        id: 'box',
        label: 'box',
        host: 'box.example',
        port: 22,
        username: 'ada',
        source: 'manual' as const
      }),
      getSystemSshResolvedConfig: () => null,
      usesSystemSshTransport: () => false
    } as unknown as SshConnection
    const provider = createSshHerdrPtyProvider(undefined, makeStore(settings), connection, 'box')
    const transport = (
      provider as unknown as { transportForTarget(): HerdrHostTransport }
    ).transportForTarget()
    expect(transport).toBeInstanceOf(HerdrSshHostTransport)
  })
})

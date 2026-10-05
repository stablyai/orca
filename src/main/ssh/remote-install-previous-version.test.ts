import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as DeployHelpers from './ssh-relay-deploy-helpers'

vi.mock('./ssh-relay-deploy-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof DeployHelpers>()),
  execCommand: vi.fn()
}))

import type { SshConnection } from './ssh-connection'
import { gcOldRelayVersions } from './remote-install-gc'
import { ORCAD_INSTALL_MODEL, RELAY_INSTALL_MODEL } from './remote-install-model'
import {
  listCompletedInstallsNewestFirstCommand,
  parseCompletedInstallsNewestFirst,
  REMOTE_INSTALL_ORDER_OK
} from './remote-install-previous-version'
import { execCommand } from './ssh-relay-deploy-helpers'
import { getRemoteHostPlatform } from './ssh-remote-platform'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: all connection access is replaced by execCommand's mock.
const conn = {} as SshConnection
const host = getRemoteHostPlatform('linux-x64')
const mockExec = vi.mocked(execCommand)

describe('parseCompletedInstallsNewestFirst', () => {
  it('keeps only this model’s version dirs, in host order', () => {
    const output = [
      '/h/.orca-remote/relay-0.2.0+bbb/.install-complete',
      '/h/.orca-remote/orcad-0.2.0+bbb/.install-complete',
      '/h/.orca-remote/relay-0.1.0+aaa/.install-complete',
      REMOTE_INSTALL_ORDER_OK
    ].join('\n')
    expect(parseCompletedInstallsNewestFirst(output, RELAY_INSTALL_MODEL)).toEqual([
      'relay-0.2.0+bbb',
      'relay-0.1.0+aaa'
    ])
  })

  it('is null when the host did not finish the listing', () => {
    expect(
      parseCompletedInstallsNewestFirst(
        '/h/.orca-remote/relay-0.1.0+aaa/.install-complete',
        RELAY_INSTALL_MODEL
      )
    ).toBeNull()
  })
})

const posixOnly = process.platform === 'win32' ? describe.skip : describe

posixOnly('listCompletedInstallsNewestFirstCommand (real shell)', () => {
  let base: string
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'install-order-'))
  })
  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
  })

  function install(name: string, mtimeSeconds: number, complete = true): void {
    mkdirSync(join(base, name))
    if (complete) {
      const marker = join(base, name, '.install-complete')
      writeFileSync(marker, '')
      utimesSync(marker, mtimeSeconds, mtimeSeconds)
    }
  }

  function run(): string[] | null {
    const out = execFileSync(
      '/bin/sh',
      ['-c', listCompletedInstallsNewestFirstCommand(host, base, RELAY_INSTALL_MODEL)],
      { encoding: 'utf8' }
    )
    return parseCompletedInstallsNewestFirst(out, RELAY_INSTALL_MODEL)
  }

  it('orders completed installs by marker mtime and skips torn ones', () => {
    install('relay-0.1.0+aaa', 1_000)
    install('relay-0.3.0+ccc', 3_000)
    install('relay-0.2.0+bbb', 2_000)
    install('relay-0.4.0+ddd', 4_000, false)
    install('orcad-0.9.0+eee', 9_000)

    expect(run()).toEqual(['relay-0.3.0+ccc', 'relay-0.2.0+bbb', 'relay-0.1.0+aaa'])
  })

  it('answers an empty order for a base without completed installs', () => {
    expect(run()).toEqual([])
  })

  it('is scoped to the model prefix', () => {
    install('orcad-0.9.0+eee', 9_000)
    const out = execFileSync(
      '/bin/sh',
      ['-c', listCompletedInstallsNewestFirstCommand(host, base, ORCAD_INSTALL_MODEL)],
      { encoding: 'utf8' }
    )
    expect(parseCompletedInstallsNewestFirst(out, ORCAD_INSTALL_MODEL)).toEqual(['orcad-0.9.0+eee'])
  })
})

describe('relay GC keeps the previous build', () => {
  beforeEach(() => {
    mockExec.mockReset()
    mockExec.mockResolvedValue('')
  })

  it('never probes or removes the most recent other completed install', async () => {
    mockExec
      .mockResolvedValueOnce('relay-0.1.0+aaa\n')
      .mockResolvedValueOnce(
        [
          '/home/u/.orca-remote/relay-0.2.0+bbb/.install-complete',
          '/home/u/.orca-remote/relay-0.1.0+aaa/.install-complete',
          REMOTE_INSTALL_ORDER_OK
        ].join('\n')
      )

    await gcOldRelayVersions(conn, '/home/u', '/home/u/.orca-remote/relay-0.2.0+bbb', host)

    expect(mockExec).toHaveBeenCalledTimes(2)
  })

  it('deletes nothing when the host cannot report install order', async () => {
    mockExec
      .mockResolvedValueOnce('relay-0.1.0+aaa\nrelay-0.0.9+zzz\n')
      .mockRejectedValueOnce(
        Object.assign(new Error('ls failed'), { sshChannelCloseConfirmed: true })
      )

    await gcOldRelayVersions(conn, '/home/u', '/home/u/.orca-remote/relay-0.2.0+bbb', host)

    expect(mockExec).toHaveBeenCalledTimes(2)
  })

  it('keeps an old build whose liveness probe times out', async () => {
    mockExec
      .mockResolvedValueOnce('relay-0.1.0+aaa\n')
      .mockResolvedValueOnce(`relay-0.1.5+fff\n${REMOTE_INSTALL_ORDER_OK}`)
      .mockResolvedValueOnce('OPEN')
      .mockResolvedValueOnce('COMPLETE')
      .mockRejectedValueOnce(
        Object.assign(new Error('SSH command timed out'), { sshChannelCloseConfirmed: true })
      )

    await gcOldRelayVersions(conn, '/home/u', '/home/u/.orca-remote/relay-0.2.0+bbb', host, {
      nodePath: '/usr/bin/node'
    })

    const commands = mockExec.mock.calls.map(([, command]) => command)
    expect(commands[4]).toContain('.relay-pid')
    expect(commands.some((command) => command.includes('gc-claim'))).toBe(false)
    expect(mockExec).toHaveBeenCalledTimes(5)
  })
})

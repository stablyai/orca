import { execFileSync } from 'node:child_process'
import { Script } from 'node:vm'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  windowsPipesNotRunHere,
  parseWindowsRelayInventory,
  WINDOWS_PIPE_ACCESS_JS,
  WINDOWS_RELAY_INVENTORY_JS
} from './ssh-host-relay-windows-inventory'
import { relaySocketNameForInstanceId } from './ssh-relay-instance-id'
import { windowsRelayPipePathsForSocketName } from './ssh-relay-endpoints'
import { getRemoteHostPlatform, joinRemotePath } from './ssh-remote-platform'

const host = getRemoteHostPlatform('win32-x64')
const HOME = 'C:\\Users\\dev'
const VERSION = 'relay-0.1.0+aaaaaaaaaaaa'
const DIR = joinRemotePath(host, HOME, '.orca-remote', VERSION)

describe('the Windows relay inventory', () => {
  let base: string | null = null
  afterEach(() => {
    if (base) {
      rmSync(base, { recursive: true, force: true })
      base = null
    }
  })

  it("reads every version directory's credentials and pipe markers", () => {
    base = mkdtempSync(join(tmpdir(), 'orca-win-inventory-'))
    mkdirSync(join(base, VERSION))
    writeFileSync(join(base, VERSION, 'relay-abc.sock.credential'), 'secret')
    writeFileSync(join(base, VERSION, '.windows-active-pipe-relay-abc.sock'), '\\\\.\\pipe\\x\n')
    writeFileSync(join(base, VERSION, 'relay.js'), '')

    const output = execFileSync(process.execPath, ['-e', WINDOWS_RELAY_INVENTORY_JS, base], {
      encoding: 'utf8'
    })

    // Off Windows `\\.\pipe\` cannot be listed, which the parser must treat as incomplete.
    expect(JSON.parse(output)).toEqual({
      pipes: process.platform === 'win32' ? expect.any(Array) : null,
      dirs: {
        [VERSION]: {
          credentials: ['relay-abc.sock.credential'],
          markers: { '.windows-active-pipe-relay-abc.sock': '\\\\.\\pipe\\x' }
        }
      }
    })
  })

  it('compiles the pipe access probe', () => {
    expect(() => new Script(WINDOWS_PIPE_ACCESS_JS)).not.toThrow()
  })

  it("maps another desktop's pipes to its own instance and credential", () => {
    const sockName = relaySocketNameForInstanceId('desktop-b')
    const [primary] = windowsRelayPipePathsForSocketName(host, DIR, sockName)
    const inventory = parseWindowsRelayInventory(
      host,
      HOME,
      [],
      JSON.stringify({
        pipes: [primary.slice('\\\\.\\pipe\\'.length)],
        dirs: { [VERSION]: { credentials: [`${sockName}.credential`], markers: {} } }
      })
    )

    expect(inventory?.pipes).toEqual([primary])
    expect(inventory?.owners.get(primary.toLowerCase())).toEqual({
      dir: DIR,
      credentialFile: joinRemotePath(host, DIR, `${sockName}.credential`)
    })
  })

  it('treats an unlisted pipe table or an unreadable directory as incomplete', () => {
    expect(parseWindowsRelayInventory(host, HOME, [], 'not json')).toBeNull()
    expect(parseWindowsRelayInventory(host, HOME, [], '{"pipes":null,"dirs":{}}')).toBeNull()
    expect(
      parseWindowsRelayInventory(
        host,
        HOME,
        [],
        JSON.stringify({ pipes: [], dirs: { [VERSION]: null } })
      )
    ).toBeNull()
  })

  it("sets aside only pipes the host proved another account's or gone", () => {
    expect(
      windowsPipesNotRunHere(
        JSON.stringify({ '\\\\.\\pipe\\A': 'EACCES', '\\\\.\\pipe\\B': 'ok', C: 'ENOENT' })
      )
    ).toEqual(new Set(['\\\\.\\pipe\\a', 'c']))
    expect(windowsPipesNotRunHere('garbage')).toEqual(new Set())
  })
})

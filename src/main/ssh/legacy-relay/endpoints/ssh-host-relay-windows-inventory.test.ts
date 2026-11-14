import { execFileSync } from 'node:child_process'

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  parseWindowsRelayInventory,
  WINDOWS_RELAY_INVENTORY_JS
} from './ssh-host-relay-windows-inventory'
import { getRemoteHostPlatform } from '../../remote-host/ssh-remote-platform'

const host = getRemoteHostPlatform('win32-x64')
const HOME = 'C:\\Users\\dev'
const VERSION = 'relay-0.1.0+aaaaaaaaaaaa'

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
})

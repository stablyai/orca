import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { UNVERIFIABLE_ORCAD_TERMINAL_CENSUS } from '../../shared/orcad-terminal-census'
import { encodePairingOffer } from '../../shared/pairing'
import { createFakeWslHostConnector } from './wsl-host-e2e-fake-connector'

const pairingCode = encodePairingOffer({
  v: 2,
  endpoint: 'ws://127.0.0.1:42000',
  deviceToken: 'fake-token',
  publicKeyB64: Buffer.alloc(32, 7).toString('base64')
})
const runtime = {
  call: async () => ({}),
  census: async () => UNVERIFIABLE_ORCAD_TERMINAL_CENSUS
}

let dir: string
let distrosFile: string

function writeState(state: 'running' | 'stopped'): void {
  writeFileSync(distrosFile, JSON.stringify([{ name: 'Ubuntu', state, version: 2 }]))
}

function connector(onChange = vi.fn(), stopSilently = false) {
  const fake = createFakeWslHostConnector(
    { distros: [], distrosFile, pairingCode, stopSilently },
    onChange,
    { isKnownDistro: () => true, runtime }
  )
  return { fake, onChange }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-fake-wsl-'))
  distrosFile = join(dir, 'distros.json')
  writeState('running')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

it('drops the bridge of a distro the test stops and refuses a no-boot reconnect', async () => {
  const { fake, onChange } = connector()
  await fake.connect('Ubuntu')
  expect(await fake.reachability('Ubuntu', 'wsl:ubuntu')).toBe('available')
  writeState('stopped')
  expect(await fake.reachability('Ubuntu', 'wsl:ubuntu')).toBe('stopped')
  expect(fake.get('Ubuntu')).toBeNull()
  // Matches production liveness, which reports the stop rather than a plain close.
  expect(onChange).toHaveBeenLastCalledWith('Ubuntu', null, {
    state: 'distro-stopped',
    terminals: 'exited',
    recovering: false
  })
  await expect(fake.connect('Ubuntu', { noBoot: true })).rejects.toThrow('Ubuntu is not running.')
})

it('leaves a silent stop for a runtime call to report, as when liveness saw only a quick reboot', async () => {
  const { fake, onChange } = connector(vi.fn(), true)
  await fake.connect('Ubuntu')
  writeState('stopped')
  expect(await fake.reachability('Ubuntu', 'wsl:ubuntu')).toBe('stopped')
  expect(onChange).toHaveBeenLastCalledWith('Ubuntu', null, { state: 'closed' })
})

it('still reports a plain close for an explicit disconnect of a running distro', async () => {
  const { fake, onChange } = connector()
  await fake.connect('Ubuntu')
  await fake.disconnect('Ubuntu')
  expect(onChange).toHaveBeenLastCalledWith('Ubuntu', null, { state: 'closed' })
})

it('boots a stopped distro on a plain connect', async () => {
  const { fake } = connector()
  writeState('stopped')
  await fake.connect('Ubuntu')
  expect(JSON.parse(readFileSync(distrosFile, 'utf8'))).toEqual([
    { name: 'Ubuntu', state: 'running', version: 2 }
  ])
  expect(await fake.reachability('Ubuntu', 'wsl:ubuntu')).toBe('available')
})

it('keeps a fixed listing always running', async () => {
  const fake = createFakeWslHostConnector(
    { distros: [{ name: 'Legacy', state: 'stopped', version: 1 }], pairingCode },
    vi.fn(),
    { isKnownDistro: () => true, runtime }
  )
  expect(await fake.reachability('Legacy', 'wsl:legacy')).toBe('unreachable')
  await fake.connect('Legacy', { noBoot: true })
  expect(await fake.reachability('Legacy', 'wsl:legacy')).toBe('available')
})

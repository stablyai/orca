import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseArgs, validateCommandAndFlags } from '../args'
import { dispatch } from '../dispatch'
import { formatPetLibrary } from '../pet-format'
import { RuntimeClient } from '../runtime-client'
import { PET_COMMAND_SPECS } from '../specs/pet'
import type { PetLibrary } from '../../shared/pet-types'

const LIBRARY: PetLibrary = {
  activePetId: '11111111-1111-4111-8111-111111111111',
  visible: true,
  pets: [
    { id: 'claude-the-mage', name: null, kind: 'built-in', active: false },
    {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Da Vinci',
      kind: 'bundle',
      active: true
    }
  ]
}

describe('pet commands', () => {
  let client: RuntimeClient

  function run(args: string[]) {
    const parsed = parseArgs(['pet', ...args])
    validateCommandAndFlags(PET_COMMAND_SPECS, parsed)
    return dispatch(parsed.commandPath, {
      flags: parsed.flags,
      client,
      cwd: '/home/me/pets',
      json: true
    })
  }

  beforeEach(() => {
    client = new RuntimeClient('/tmp/orca-pet-test', 60_000, null, null)
    vi.spyOn(client, 'call').mockResolvedValue({
      id: 'pet',
      ok: true as const,
      result: LIBRARY,
      _meta: { runtimeId: 'test-runtime' }
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('resolves a relative bundle path against the CLI cwd', async () => {
    await run(['import', '--path', 'leonardo', '--name', 'Da Vinci', '--json'])

    expect(client.call).toHaveBeenCalledExactlyOnceWith('pet.importBundle', {
      // Why path.resolve: the handler resolves with the host's path rules, which differ on Windows.
      path: path.resolve('/home/me/pets', 'leonardo'),
      name: 'Da Vinci'
    })
  })

  it('refuses a relative bundle path for a paired runtime', async () => {
    vi.spyOn(client, 'isRemote', 'get').mockReturnValue(true)

    await expect(run(['import', '--path', 'leonardo'])).rejects.toThrow(
      'Remote pet import requires --path to be an absolute path'
    )
    expect(client.call).not.toHaveBeenCalled()
  })

  it.each([
    { args: ['select', '--pet', 'Da Vinci'], method: 'pet.select', params: { pet: 'Da Vinci' } },
    {
      args: ['rename', '--pet', 'Leonardo da Vinci', '--name', 'Da Vinci'],
      method: 'pet.rename',
      params: { pet: 'Leonardo da Vinci', name: 'Da Vinci' }
    },
    { args: ['rm', '--pet', 'Da Vinci'], method: 'pet.remove', params: { pet: 'Da Vinci' } }
  ])('sends $method', async ({ args, method, params }) => {
    await run([...args, '--json'])

    expect(client.call).toHaveBeenCalledExactlyOnceWith(method, params)
  })

  it('marks the active pet and names only custom pets', () => {
    expect(formatPetLibrary(LIBRARY)).toBe(
      [
        '  claude-the-mage  built-in',
        '* 11111111-1111-4111-8111-111111111111  bundle  Da Vinci'
      ].join('\n')
    )
  })
})

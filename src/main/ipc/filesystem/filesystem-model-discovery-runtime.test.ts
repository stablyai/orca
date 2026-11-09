import { expect, it } from 'vitest'
import { fixture, io } from './terminal-model-discovery.test-fixture'

it.each([
  {
    name: 'native shell with leftover distro',
    shell: 'powershell.exe',
    distro: 'Ubuntu',
    model: 'native-model',
    guest: undefined
  },
  { name: 'default WSL shell', shell: 'wsl.exe', model: 'ubuntu-model', guest: 'Ubuntu' },
  {
    name: 'UNC authority',
    path: '\\\\wsl.localhost\\Ubuntu\\home\\me',
    distro: 'Debian',
    model: 'ubuntu-model',
    guest: 'Ubuntu'
  },
  {
    name: 'mixed project repo',
    repo: true,
    runtime: { kind: 'wsl', distro: 'Ubuntu', git: 'windows-host' },
    model: 'ubuntu-model',
    guest: 'Ubuntu'
  },
  {
    name: 'associated folder',
    runtime: { kind: 'wsl', distro: 'Ubuntu', git: 'windows-host' },
    model: 'ubuntu-model',
    guest: 'Ubuntu'
  },
  {
    name: 'forced host project',
    repo: true,
    shell: 'wsl.exe',
    runtime: { kind: 'windows-host' },
    model: 'native-model',
    guest: undefined
  },
  {
    name: 'Mac stale preference',
    platform: 'darwin',
    shell: 'wsl.exe',
    distro: 'Ubuntu',
    model: 'native-model',
    guest: undefined
  },
  {
    name: 'Linux stale preference',
    platform: 'linux',
    shell: 'wsl.exe',
    distro: 'Ubuntu',
    model: 'native-model',
    guest: undefined
  }
] as const)('$name uses the effective terminal runtime through IPC and RPC', async (input) => {
  const rig = fixture(input)
  for (const read of [rig.ipc, rig.rpc]) {
    expect(await read()).toMatchObject({ success: true, models: [{ id: input.model }] })
    expect(io.env.mock.calls.at(-1)?.[2]).toEqual(
      input.guest ? { runtime: 'wsl', wslDistro: input.guest } : { runtime: 'host' }
    )
    expect(io.discover.mock.calls.at(-1)?.[3]).toEqual(
      input.guest ? { cwd: rig.path, wslDistro: input.guest } : { cwd: rig.path }
    )
  }
  expect(io.userAct).not.toHaveBeenCalled()
})

it('does not probe natively when the WSL default is unresolved, and retries when the catalog fills', async () => {
  const rig = fixture({ shell: 'wsl.exe' })
  io.distros = []
  expect(await rig.ipc()).toEqual({
    success: false,
    error: 'terminal_execution_context_unresolved'
  })
  expect(io.env).not.toHaveBeenCalled()
  expect(io.discover).not.toHaveBeenCalled()
  io.distros = ['Ubuntu']
  expect(await rig.rpc()).toMatchObject({ success: true, models: [{ id: 'ubuntu-model' }] })
})

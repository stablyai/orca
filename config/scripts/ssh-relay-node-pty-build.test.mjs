import { describe, expect, it } from 'vitest'

import { nodePtyNativeBuildCommands } from './ssh-relay-node-pty-build.mjs'

const nodePath = '/staged/node'
const nodeRoot = '/staged/node-root'

describe('SSH relay node-pty native build commands', () => {
  it('uses the ordinary node-gyp rebuild on Linux and Windows', () => {
    for (const tuple of ['linux-x64-glibc', 'linux-arm64-glibc', 'win32-x64', 'win32-arm64']) {
      const commands = nodePtyNativeBuildCommands({ nodePath, nodeRoot, tuple })
      expect(commands).toHaveLength(1)
      expect(commands[0]).toMatchObject({ command: nodePath })
      expect(commands[0].args).toEqual(
        expect.arrayContaining(['rebuild', '--release', `--nodedir=${nodeRoot}`])
      )
      expect(commands[0].args).not.toContain('LDFLAGS.target=-Wl,-reproducible')
    }
  })

  it('configures macOS before reproducibly linking a loadable Mach-O UUID', () => {
    for (const tuple of ['darwin-x64', 'darwin-arm64']) {
      const commands = nodePtyNativeBuildCommands({ nodePath, nodeRoot, tuple })
      expect(commands).toHaveLength(2)
      expect(commands[0]).toMatchObject({ command: nodePath })
      expect(commands[0].args).toEqual(
        expect.arrayContaining(['configure', '--release', `--nodedir=${nodeRoot}`])
      )
      expect(commands[1]).toEqual({
        command: 'make',
        args: ['-C', 'build', 'BUILDTYPE=Release', 'LDFLAGS.target=-Wl,-reproducible']
      })
    }
  })
})

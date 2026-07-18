import { describe, expect, it } from 'vitest'
import {
  buildPosixNodeToolchainProbe,
  buildWindowsNodeToolchainProbe,
  nodeToolchainVersionsMeetRequirements
} from './ssh-remote-node-toolchain-probe'

describe('remote Node/npm toolchain probe', () => {
  it('probes npm beside the selected POSIX Node with that directory on PATH', () => {
    expect(buildPosixNodeToolchainProbe('/home/u/My Node/bin/node')).toBe(
      "printf '%s\\n' '__ORCA_NODE_VERSION__' && '/home/u/My Node/bin/node' --version && " +
        "printf '%s\\n' '__ORCA_NPM_VERSION__' && PATH='/home/u/My Node/bin':$PATH " +
        "'/home/u/My Node/bin/npm' --version"
    )
  })

  it('probes npm.cmd beside the selected Windows Node', () => {
    const probe = buildWindowsNodeToolchainProbe('C:/Program Files/nodejs/node.exe')

    expect(probe).toContain("Test-Path -LiteralPath 'C:/Program Files/nodejs/npm.cmd'")
    expect(probe).toContain("$env:PATH = 'C:/Program Files/nodejs' + ';' + $env:PATH")
    expect(probe).toContain("& 'C:/Program Files/nodejs/npm.cmd' --version")
  })

  it('requires marked, parseable Node and npm versions', () => {
    expect(
      nodeToolchainVersionsMeetRequirements(
        'banner\n__ORCA_NODE_VERSION__\nv22.22.0\n__ORCA_NPM_VERSION__\n11.13.0\n'
      )
    ).toBe(true)
    expect(
      nodeToolchainVersionsMeetRequirements(
        '__ORCA_NODE_VERSION__\nv22.22.0\n__ORCA_NPM_VERSION__\nshim did nothing\n'
      )
    ).toBe(false)
    expect(
      nodeToolchainVersionsMeetRequirements(
        '__ORCA_NODE_VERSION__\nv16.20.2\n__ORCA_NPM_VERSION__\n10.8.2\n'
      )
    ).toBe(false)
  })

  it('accepts legacy Node-only output from existing proxy integrations', () => {
    expect(nodeToolchainVersionsMeetRequirements('v18.0.0\n')).toBe(true)
    expect(nodeToolchainVersionsMeetRequirements('v16.20.2\n')).toBe(false)
  })
})

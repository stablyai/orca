import { describe, expect, it } from 'vitest'
import {
  buildPosixNodeToolchainProbe,
  buildWindowsNodeToolchainProbe,
  nodeToolchainVersionsMeetRequirements
} from './ssh-remote-node-toolchain-probe'

describe('remote Node/npm toolchain probe', () => {
  it('probes bare npm with the selected POSIX Node directory prepended to PATH', () => {
    // Deploy runs bare `npm` under the same prepended PATH, so accept npm from
    // anywhere on PATH rather than requiring it colocated with node (#9165).
    expect(buildPosixNodeToolchainProbe('/home/u/My Node/bin/node')).toBe(
      "printf '%s\\n' '__ORCA_NODE_VERSION__' && '/home/u/My Node/bin/node' --version && " +
        "printf '%s\\n' '__ORCA_NPM_VERSION__' && PATH='/home/u/My Node/bin':$PATH npm --version"
    )
  })

  it('probes bare npm with the selected Windows Node directory prepended to PATH', () => {
    const probe = buildWindowsNodeToolchainProbe('C:/Program Files/nodejs/node.exe')

    expect(probe).not.toContain('Test-Path')
    expect(probe).toContain("$env:PATH = 'C:\\Program Files\\nodejs' + ';' + $env:PATH")
    expect(probe).toContain("& 'C:/Program Files/nodejs/node.exe' --version")
    expect(probe).toContain('& npm --version')
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

import { describe, expect, it } from 'vitest'
import {
  buildPosixNodeToolchainProbe,
  buildWindowsNodeToolchainProbe,
  hostNodeMeetsAddonRequirements,
  nodeToolchainVersionsMeetRequirements,
  parseHostNodeAddonFacts
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
        'banner\n__ORCA_NODE_VERSION__\nv24.0.0\n__ORCA_NPM_VERSION__\n11.13.0\n'
      )
    ).toBe(true)
    expect(
      nodeToolchainVersionsMeetRequirements(
        '__ORCA_NODE_VERSION__\nv24.0.0\n__ORCA_NPM_VERSION__\nshim did nothing\n'
      )
    ).toBe(false)
    expect(
      nodeToolchainVersionsMeetRequirements(
        '__ORCA_NODE_VERSION__\nv16.20.2\n__ORCA_NPM_VERSION__\n10.8.2\n'
      )
    ).toBe(false)
  })

  it('accepts legacy Node-only output from existing proxy integrations', () => {
    expect(nodeToolchainVersionsMeetRequirements('v24.0.0\n')).toBe(true)
    expect(nodeToolchainVersionsMeetRequirements('v16.20.2\n')).toBe(false)
  })

  it.each([18, 20, 22, 23, 24, 26])('gates host Node %i on every probe format', (major) => {
    const version = `v${major}.0.0`
    const qualifies = major >= 24
    expect(nodeToolchainVersionsMeetRequirements(`${version}\n`)).toBe(qualifies)
    expect(
      nodeToolchainVersionsMeetRequirements(
        `__ORCA_NODE_VERSION__\n${version}\n__ORCA_NPM_VERSION__\n11.0.0\n`
      )
    ).toBe(qualifies)
    expect(hostNodeMeetsAddonRequirements({ version: { major, minor: 0 }, napi: 10 }, 8)).toBe(
      qualifies
    )
  })

  it('probes Node and its N-API level without npm in addon-only mode', () => {
    expect(buildPosixNodeToolchainProbe('/opt/node/bin/node', 'addon-only')).toBe(
      "printf '%s\\n' '__ORCA_NODE_VERSION__' && '/opt/node/bin/node' --version && " +
        "printf '%s\\n' '__ORCA_NAPI_VERSION__' && '/opt/node/bin/node' -p process.versions.napi || true"
    )
  })

  it('parses addon facts and gates on the Node 24 floor and N-API level', () => {
    const facts = parseHostNodeAddonFacts(
      'motd\n__ORCA_NODE_VERSION__\nv24.0.0\n__ORCA_NAPI_VERSION__\n9\n'
    )
    expect(facts).toEqual({ version: { major: 24, minor: 0 }, napi: 9 })
    expect(hostNodeMeetsAddonRequirements(facts, 8)).toBe(true)
    expect(hostNodeMeetsAddonRequirements(facts, 10)).toBe(false)
    expect(
      hostNodeMeetsAddonRequirements(
        parseHostNodeAddonFacts('__ORCA_NODE_VERSION__\nv16.20.2\n__ORCA_NAPI_VERSION__\n8\n'),
        8
      )
    ).toBe(false)
    // A Node that failed to run prints no version: not a candidate.
    expect(parseHostNodeAddonFacts('__ORCA_NODE_VERSION__\n__ORCA_NAPI_VERSION__\n')).toBeNull()
  })
})

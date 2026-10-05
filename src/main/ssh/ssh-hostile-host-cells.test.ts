import { describe, expect, it } from 'vitest'
import {
  canRunHostileHostCell,
  forbiddenToolsFor,
  forbiddenToolShimScript,
  HOSTILE_HOST_CELLS,
  hostileHostCellViolations,
  isLocalSshdCell,
  parseForbiddenToolLog,
  selectHostileHostCells,
  type DockerHostileHostCell,
  type HostileHostCell,
  type HostileHostObservation
} from './ssh-hostile-host-cells'
import { hostileHostDockerfile } from './ssh-hostile-host-test-fixture'

const LINUX = { platform: 'linux', arch: 'x64' } as const
const MAC_ARM = { platform: 'darwin', arch: 'arm64' } as const
const DOCKER_CELLS = HOSTILE_HOST_CELLS.filter(
  (candidate): candidate is DockerHostileHostCell => !isLocalSshdCell(candidate)
)

function dockerCell(id: string): DockerHostileHostCell {
  const found = DOCKER_CELLS.find((candidate) => candidate.id === id)
  if (!found) {
    throw new Error(`no docker cell ${id}`)
  }
  return found
}

function cell(id: string): HostileHostCell {
  const found = HOSTILE_HOST_CELLS.find((candidate) => candidate.id === id)
  if (!found) {
    throw new Error(`no cell ${id}`)
  }
  return found
}

const launched: HostileHostObservation = {
  settledRung: 'A',
  target: 'linux-x64-glibc',
  unavailableReason: null,
  deployError: null,
  refusals: [],
  forbiddenToolCalls: []
}

describe('hostile-host cells', () => {
  it('covers each design D6 ladder outcome the matrix is meant to prove', () => {
    expect(HOSTILE_HOST_CELLS.map((c) => c.id)).toEqual([
      'debian10-glibc228',
      'almalinux8-glibc228',
      'alpine-musl',
      'alpine-musl-no-libstdcxx',
      'ubuntu2204-node20-noexec-home',
      'centos7-glibc217',
      'debian10-no-egress',
      'macos-arm64-local-sshd',
      'macos-x64-local-sshd'
    ])
    expect(new Set(HOSTILE_HOST_CELLS.map((c) => c.expect.outcome))).toEqual(
      new Set(['launched', 'unavailable'])
    )
    expect(
      new Set(
        HOSTILE_HOST_CELLS.flatMap((c) => (c.expect.outcome === 'launched' ? [c.expect.rung] : []))
      )
    ).toEqual(new Set(['A', 'B']))
  })

  it('pins every base image by digest and installs no compiler or host Node for rung A', () => {
    for (const { dockerfile, expect: expectation } of DOCKER_CELLS) {
      for (const from of dockerfile.filter((line) => line.startsWith('FROM '))) {
        expect(from).toMatch(/@sha256:[0-9a-f]{64}\b/)
      }
      if (expectation.outcome === 'launched') {
        expect(dockerfile.join('\n')).not.toMatch(/\b(?:gcc|g\+\+|build-essential|nodejs|npm)\b/)
      }
    }
  })

  it('shims the toolchain and starts sshd in every image', () => {
    const dockerfile = hostileHostDockerfile(dockerCell('alpine-musl'))
    expect(dockerfile.startsWith('FROM alpine:3.20@sha256:')).toBe(true)
    expect(dockerfile).toContain('ln -sf orca-forbidden-tool /usr/local/bin/npm')
    expect(dockerfile).toContain('ln -sf orca-forbidden-tool /usr/local/bin/gcc')
    expect(dockerfile.trimEnd().endsWith('CMD ["/orca-entrypoint.sh"]')).toBe(true)
  })

  it('selects named cells this machine can host and rejects unknown ones', () => {
    expect(selectHostileHostCells(undefined, HOSTILE_HOST_CELLS, LINUX)).toEqual(DOCKER_CELLS)
    expect(selectHostileHostCells(' ', HOSTILE_HOST_CELLS, LINUX)).toEqual(DOCKER_CELLS)
    expect(
      selectHostileHostCells('alpine-musl, centos7-glibc217', HOSTILE_HOST_CELLS, LINUX).map(
        (c) => c.id
      )
    ).toEqual(['alpine-musl', 'centos7-glibc217'])
    expect(() => selectHostileHostCells('alpine-musl,solaris', HOSTILE_HOST_CELLS, LINUX)).toThrow(
      'Unknown hostile-host cells: solaris'
    )
  })

  it('runs a macOS cell only on its own OS and arch, and no Docker cell there', () => {
    expect(selectHostileHostCells('', HOSTILE_HOST_CELLS, MAC_ARM).map((c) => c.id)).toEqual([
      'macos-arm64-local-sshd'
    ])
    expect(
      selectHostileHostCells('macos-arm64-local-sshd', HOSTILE_HOST_CELLS, MAC_ARM).map((c) => c.id)
    ).toEqual(['macos-arm64-local-sshd'])
    expect(() =>
      selectHostileHostCells('alpine-musl,macos-arm64-local-sshd', HOSTILE_HOST_CELLS, LINUX)
    ).toThrow('cannot run on linux-x64: macos-arm64-local-sshd')
    expect(() =>
      selectHostileHostCells('macos-x64-local-sshd', HOSTILE_HOST_CELLS, MAC_ARM)
    ).toThrow('cannot run on darwin-arm64: macos-x64-local-sshd')
    expect(canRunHostileHostCell(cell('macos-x64-local-sshd'), MAC_ARM)).toBe(false)
    expect(
      canRunHostileHostCell(cell('macos-x64-local-sshd'), { platform: 'darwin', arch: 'x64' })
    ).toBe(true)
  })

  it('expects each macOS runner on rung A with its own darwin slot, and forbids xattr there', () => {
    expect(cell('macos-arm64-local-sshd').expect).toEqual({
      outcome: 'launched',
      rung: 'A',
      target: 'darwin-arm64'
    })
    expect(cell('macos-x64-local-sshd').expect).toMatchObject({ target: 'darwin-x64' })
    expect(forbiddenToolsFor(cell('macos-arm64-local-sshd'))).toContain('xattr')
    expect(forbiddenToolsFor(cell('debian10-glibc228'))).not.toContain('xattr')
  })

  it('writes a shim that logs its own name and arguments, then fails like a missing tool', () => {
    expect(forbiddenToolShimScript('/tmp/x/calls.log')).toBe(
      `#!/bin/sh\nprintf '%s %s\\n' "\${0##*/}" "$*" >> '/tmp/x/calls.log'\nexit 127\n`
    )
  })

  it('reads one call per line of the shim log', () => {
    expect(parseForbiddenToolLog('npm install\n\ngcc -v\n')).toEqual(['npm install', 'gcc -v'])
  })
})

describe('hostileHostCellViolations', () => {
  it('accepts rung A with no refusals and no toolchain', () => {
    expect(hostileHostCellViolations(cell('debian10-glibc228'), launched)).toEqual([])
  })

  it('flags a rung A host that invoked npm or landed on the wrong slot', () => {
    expect(
      hostileHostCellViolations(cell('alpine-musl'), {
        ...launched,
        forbiddenToolCalls: ['npm install']
      })
    ).toEqual(['toolchain invoked: npm install', 'target linux-x64-glibc, expected linux-x64-musl'])
  })

  it('flags a launched host that stepped down the ladder', () => {
    expect(
      hostileHostCellViolations(cell('almalinux8-glibc228'), {
        ...launched,
        settledRung: 'C',
        refusals: [
          { step: 'A', reason: 'missing_lib' },
          { step: 'B', reason: 'runtime_unavailable' }
        ]
      })
    ).toEqual([
      'refusals A:missing_lib > B:runtime_unavailable, expected none',
      'settled on C, expected A'
    ])
  })

  it('requires the classified rung D reason and refusal chain', () => {
    const noexec = cell('ubuntu2204-node20-noexec-home')
    const observed: HostileHostObservation = {
      settledRung: 'D',
      target: 'linux-x64-glibc',
      unavailableReason: 'home_noexec',
      deployError: 'home directory is mounted noexec',
      refusals: [{ step: 'A', reason: 'noexec' }],
      forbiddenToolCalls: []
    }
    expect(hostileHostCellViolations(noexec, observed)).toEqual([])
    expect(
      hostileHostCellViolations(noexec, {
        ...observed,
        unavailableReason: 'no_runtime',
        refusals: [
          { step: 'A', reason: 'noexec' },
          { step: 'C', reason: 'noexec' }
        ]
      })
    ).toEqual([
      'refusals A:noexec > C:noexec, expected A:noexec',
      'rung D reason no_runtime, expected home_noexec'
    ])
  })

  it('expects a glibc 2.17 host to launch on the rung B compat runtime', () => {
    const centos = cell('centos7-glibc217')
    const observed: HostileHostObservation = {
      ...launched,
      settledRung: 'B',
      refusals: [{ step: 'A', reason: 'libc_floor' }]
    }
    expect(hostileHostCellViolations(centos, observed)).toEqual([])
    expect(
      hostileHostCellViolations(centos, {
        ...observed,
        settledRung: null,
        deployError: 'Node.js was not found on the remote host',
        refusals: [
          { step: 'A', reason: 'libc_floor' },
          { step: 'B', reason: 'artifacts_unavailable' },
          { step: 'C', reason: 'libc_floor' }
        ],
        forbiddenToolCalls: ['npm --version']
      })
    ).toEqual([
      'refusals A:libc_floor > B:artifacts_unavailable > C:libc_floor, expected A:libc_floor',
      'toolchain invoked: npm --version',
      'deploy failed: Node.js was not found on the remote host',
      'settled on nothing, expected B'
    ])
  })

  it('judges an opted-out host only on the ladder never running', () => {
    const optOut = { id: 'opt-out', expect: { outcome: 'legacy_opt_out' } } as const
    const observed: HostileHostObservation = {
      settledRung: null,
      target: null,
      unavailableReason: null,
      deployError: 'Node.js was not found on the remote host',
      refusals: [],
      forbiddenToolCalls: ['npm']
    }
    expect(hostileHostCellViolations(optOut, observed)).toEqual([])
    expect(hostileHostCellViolations(optOut, { ...observed, deployError: null })).toEqual([])
    expect(
      hostileHostCellViolations(optOut, {
        ...observed,
        settledRung: 'A',
        refusals: [{ step: 'A', reason: 'noexec' }]
      })
    ).toEqual([
      'refusals A:noexec, expected none',
      'settled on A, expected the ladder never to run'
    ])
  })
})

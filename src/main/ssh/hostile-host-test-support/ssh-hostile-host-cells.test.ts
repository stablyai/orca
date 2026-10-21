import { describe, expect, it } from 'vitest'
import {
  canRunHostileHostCell,
  forbiddenToolActions,
  forbiddenToolsFor,
  forbiddenToolShimScript,
  HOSTILE_HOST_CELLS,
  isLocalSshdCell,
  selectHostileHostCells,
  type DockerHostileHostCell,
  type HostileHostCell
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

describe('hostile-host cells', () => {
  it('states a managed orcad expectation for every host the matrix runs', () => {
    expect(HOSTILE_HOST_CELLS.map((c) => [c.id, c.managed.runtime, c.managed.outcome])).toEqual([
      ['debian10-glibc228', 'linux-x64-glibc', 'activated'],
      ['almalinux8-glibc228', 'linux-x64-glibc', 'activated'],
      ['alpine-musl', 'linux-x64-musl', 'activated'],
      ['alpine-musl-no-libstdcxx', 'linux-x64-musl', 'unavailable'],
      ['ubuntu2204-noexec-home', 'linux-x64-glibc', 'unavailable'],
      ['centos7-glibc217', 'linux-x64-glibc217', 'activated'],
      ['debian10-no-egress', 'linux-x64-glibc', 'activated'],
      ['almalinux8-desktop-no-egress', 'linux-x64-glibc', 'activated'],
      ['macos-arm64-local-sshd', 'darwin-arm64', 'activated'],
      ['macos-x64-local-sshd', 'darwin-x64', 'activated']
    ])
  })

  it('pins every base image by digest and installs no compiler or host Node', () => {
    for (const { dockerfile } of DOCKER_CELLS) {
      for (const from of dockerfile.filter((line) => line.startsWith('FROM '))) {
        expect(from).toMatch(/@sha256:[0-9a-f]{64}\b/)
      }
      expect(dockerfile.join('\n')).not.toMatch(/\b(?:gcc|g\+\+|build-essential|nodejs|npm)\b/)
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

  it('forbids xattr only on the macOS runners', () => {
    expect(forbiddenToolsFor(cell('macos-arm64-local-sshd'))).toContain('xattr')
    expect(forbiddenToolsFor(cell('debian10-glibc228'))).not.toContain('xattr')
  })

  it('writes a shim that logs its own name and arguments, then fails like a missing tool', () => {
    expect(forbiddenToolShimScript('/tmp/x/calls.log')).toBe(
      `#!/bin/sh\nprintf '%s %s\\n' "\${0##*/}" "$*" >> '/tmp/x/calls.log'\nexit 127\n`
    )
  })

  it('reports logged installs and compiles but not version probes', () => {
    expect(forbiddenToolActions('npm install\n\ngcc -v\nnpm --version\nmake all\n')).toEqual([
      'npm install',
      'make all'
    ])
  })
})

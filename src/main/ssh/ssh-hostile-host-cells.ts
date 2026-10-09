/**
 * The design D5/D6 hostile-host matrix: each cell is an SSH target (a container, or the runner's
 * own loopback sshd) and the place the relay runtime ladder must land there.
 * `ssh-relay-hostile-hosts.docker.test.ts` drives the real client-side deploy against each one;
 * `.github/workflows/ssh-hostile-hosts.yml` runs it.
 */
import type { NodeRuntimeTarget, ServerTarget } from '../../shared/node-runtime-pin'
import type { SshRemoteRuntimeRung } from '../../shared/ssh-types'
import type { RelayRuntimeFallbackReason } from './ssh-relay-pinned-node'
import type { RelayRuntimeStep, RemoteRuntimeUnavailableReason } from './ssh-relay-runtime-ladder'

/** Every shimmed toolchain command appends its name here; rungs A and C must leave it empty. */
export const FORBIDDEN_TOOL_LOG = '/tmp/orca-forbidden-tool-calls.log'
export const FORBIDDEN_TOOLS = ['npm', 'npx', 'node-gyp', 'gcc', 'g++', 'cc', 'c++', 'make']

/** The shim every forbidden tool name links to: it records the call and fails like a missing tool. */
export function forbiddenToolShimScript(logPath: string): string {
  return ['#!/bin/sh', `printf '%s %s\\n' "\${0##*/}" "$*" >> '${logPath}'`, 'exit 127', ''].join(
    '\n'
  )
}

export type RungRefusal = { step: RelayRuntimeStep; reason: RelayRuntimeFallbackReason }

export type HostileHostExpectation =
  /** A pinned rung ran: the terminal echoes, a second connect reuses the runtime, GC keeps it. */
  | {
      outcome: 'launched'
      rung: 'A' | 'B'
      /** The host's target; `runtime` names the compat runtime rung B ran on instead. */
      target: ServerTarget
      runtime?: NodeRuntimeTarget
      refusals?: readonly RungRefusal[]
    }
  /** Rung D: nothing may run, and the connect fails with the classified reason. */
  | {
      outcome: 'unavailable'
      reason: RemoteRuntimeUnavailableReason
      refusals: readonly RungRefusal[]
    }
  /** The host opted out: the ladder never runs and nothing enters the pinned runtime store. */
  | { outcome: 'legacy_opt_out' }

/** What any hostile-host driver needs, whatever provisions the host. */
export type HostileHostCellCore = {
  id: string
  expect: HostileHostExpectation
  /** Also deploy managed orcad on a fresh host, on this runtime target. */
  managed?: ManagedOrcadExpectation
}

export type ManagedOrcadExpectation =
  | { outcome: 'activated'; runtime: NodeRuntimeTarget }
  /** The candidate is refused with this deferral code, and the relay that follows settles on `relayRung`. */
  | { outcome: 'refused'; runtime: NodeRuntimeTarget; code: string; relayRung: 'A' | 'B' }

export type DockerHostileHostCell = HostileHostCellCore & {
  host?: 'docker'
  /** Dockerfile lines, FROM included; the harness appends sshd and the toolchain shims. */
  dockerfile: readonly string[]
  /** Mount `/root` as a noexec tmpfs, the way a hardened host mounts home. */
  homeNoexec?: boolean
  /** Attach only to a `docker network create --internal` network: the host has no egress. */
  noEgress?: boolean
}

/**
 * The runner itself as the SSH host: a user-level sshd on a loopback port logs in as the runner
 * user with PATH cut to the shims and the OS base, and HOME moved to an empty directory so no
 * profile or rc file puts Homebrew or a toolchain back.
 */
export type LocalSshdHostileHostCell = HostileHostCellCore & {
  host: 'local-sshd'
  /** The machine the cell must run on; its runtime target is this machine's own. */
  runsOn: { platform: NodeJS.Platform; arch: string }
  /** Shimmed beside FORBIDDEN_TOOLS for this host only. */
  extraForbiddenTools?: readonly string[]
}

export type HostileHostCell = DockerHostileHostCell | LocalSshdHostileHostCell

export function isLocalSshdCell(cell: HostileHostCell): cell is LocalSshdHostileHostCell {
  return cell.host === 'local-sshd'
}

export function forbiddenToolsFor(cell: HostileHostCell): string[] {
  return [...FORBIDDEN_TOOLS, ...(isLocalSshdCell(cell) ? (cell.extraForbiddenTools ?? []) : [])]
}

// Why xattr: SFTP writes carry no com.apple.quarantine, so the pinned Node must run as uploaded;
// a deploy that reached for `xattr -d` would be papering over a Gatekeeper block.
const MACOS_FORBIDDEN_TOOLS = ['xattr']

// Digests are the multi-arch indexes of each tag as of 2026-09-30.
const DEBIAN_10 =
  'debian:10@sha256:58ce6f1271ae1c8a2006ff7d3e54e9874d839f573d8009c20154ad0f2fb0a225'
const ALMALINUX_8 =
  'almalinux:8@sha256:9f355ae942d6a6c0561f0771dc053a2cfae9580fc45fa4252756db7c7e80c09f'
const ALPINE_3_20 =
  'alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc'
const UBUNTU_22_04 =
  'ubuntu:22.04@sha256:b8b6ee6aa931ecd9d0d952abc34dc0e5f7c6a30c6bb71b079fe399fde0329c02'
const CENTOS_7 = 'centos:7@sha256:be65f488b7764ad3638f236b7b515b3678369a5124c47b8d32916d6487418ea4'
const NODE_20 =
  'node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0'

// Why the archive: buster left deb.debian.org; its packages live on only at archive.debian.org.
const DEBIAN_10_LINES = [
  `FROM ${DEBIAN_10}`,
  "RUN printf '%s\\n' 'deb http://archive.debian.org/debian buster main' 'deb http://archive.debian.org/debian-security buster/updates main' > /etc/apt/sources.list" +
    ' && apt-get -o Acquire::Check-Valid-Until=false update' +
    ' && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends openssh-server procps' +
    ' && rm -rf /var/lib/apt/lists/*'
]

const ALPINE_SSHD = 'RUN apk add --no-cache openssh'

export const HOSTILE_HOST_CELLS: readonly HostileHostCell[] = [
  {
    id: 'debian10-glibc228',
    dockerfile: DEBIAN_10_LINES,
    expect: { outcome: 'launched', rung: 'A', target: 'linux-x64-glibc' }
  },
  {
    id: 'almalinux8-glibc228',
    dockerfile: [
      `FROM ${ALMALINUX_8}`,
      'RUN dnf install -y openssh-server procps-ng tar gzip && dnf clean all'
    ],
    expect: { outcome: 'launched', rung: 'A', target: 'linux-x64-glibc' }
  },
  {
    id: 'alpine-musl',
    dockerfile: [`FROM ${ALPINE_3_20}`, `${ALPINE_SSHD} libgcc libstdc++`],
    expect: { outcome: 'launched', rung: 'A', target: 'linux-x64-musl' }
  },
  {
    // The musl Node links libstdc++, so its self-test proves the missing library; B has no
    // compat runtime yet, C finds no host Node, and the host-Node fallback proves it has none.
    id: 'alpine-musl-no-libstdcxx',
    dockerfile: [`FROM ${ALPINE_3_20}`, ALPINE_SSHD],
    expect: {
      outcome: 'unavailable',
      reason: 'no_runtime',
      refusals: [
        { step: 'A', reason: 'missing_lib' },
        { step: 'B', reason: 'runtime_unavailable' },
        { step: 'C', reason: 'host_node_missing' },
        { step: 'legacy', reason: 'host_node_missing' }
      ]
    }
  },
  {
    // A proved noexec skips B and C (same tree) for the host-Node fallback, which finds Node 20
    // without npm; that answered "no Node" is the only way to D.
    id: 'ubuntu2204-node20-noexec-home',
    dockerfile: [
      `FROM ${NODE_20} AS host-node`,
      `FROM ${UBUNTU_22_04}`,
      'RUN apt-get update' +
        ' && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends openssh-server procps' +
        ' && rm -rf /var/lib/apt/lists/*',
      'COPY --from=host-node /usr/local/bin/node /usr/local/bin/node'
    ],
    homeNoexec: true,
    expect: {
      outcome: 'unavailable',
      reason: 'home_noexec',
      refusals: [
        { step: 'A', reason: 'noexec' },
        { step: 'legacy', reason: 'host_node_missing' }
      ]
    }
  },
  {
    // glibc 2.17 is below the pinned Node's floor, so rung B runs the glibc 2.17 compat runtime.
    id: 'centos7-glibc217',
    dockerfile: [
      `FROM ${CENTOS_7}`,
      // Why the vault: CentOS 7 is end of life and mirror.centos.org no longer serves it.
      "RUN sed -i -e 's/^mirrorlist=/#mirrorlist=/' -e 's|^#\\?baseurl=http://mirror.centos.org/centos/$releasever|baseurl=http://vault.centos.org/7.9.2009|' /etc/yum.repos.d/CentOS-*.repo" +
        ' && yum install -y openssh-server procps-ng && yum clean all'
    ],
    expect: {
      outcome: 'launched',
      rung: 'B',
      target: 'linux-x64-glibc',
      runtime: 'linux-x64-glibc217',
      refusals: [{ step: 'A', reason: 'libc_floor' }]
    },
    // Managed orcad runs on the same compat runtime and slot, so an empty CentOS 7 host is managed.
    managed: { outcome: 'activated', runtime: 'linux-x64-glibc217' }
  },
  {
    // The client uploads the runtime over SSH, so a host that cannot reach nodejs.org still runs A.
    id: 'debian10-no-egress',
    dockerfile: DEBIAN_10_LINES,
    noEgress: true,
    expect: { outcome: 'launched', rung: 'A', target: 'linux-x64-glibc' }
  },
  {
    id: 'macos-arm64-local-sshd',
    host: 'local-sshd',
    runsOn: { platform: 'darwin', arch: 'arm64' },
    extraForbiddenTools: MACOS_FORBIDDEN_TOOLS,
    expect: { outcome: 'launched', rung: 'A', target: 'darwin-arm64' }
  },
  {
    id: 'macos-x64-local-sshd',
    host: 'local-sshd',
    runsOn: { platform: 'darwin', arch: 'x64' },
    extraForbiddenTools: MACOS_FORBIDDEN_TOOLS,
    expect: { outcome: 'launched', rung: 'A', target: 'darwin-x64' }
  }
]

export type HostileHostMachine = { platform: NodeJS.Platform; arch: string }

/** Docker cells need a Linux daemon that shares its bridge; loopback cells need their own OS. */
export function canRunHostileHostCell(cell: HostileHostCell, machine: HostileHostMachine): boolean {
  if (isLocalSshdCell(cell)) {
    return cell.runsOn.platform === machine.platform && cell.runsOn.arch === machine.arch
  }
  return machine.platform === 'linux'
}

/**
 * `ORCA_SSH_HOSTILE_HOST_CELLS=a,b` narrows a run and every named cell must be hostable here;
 * unset or empty runs every cell this machine can host.
 */
export function selectHostileHostCells(
  filter: string | undefined,
  cells: readonly HostileHostCell[] = HOSTILE_HOST_CELLS,
  machine: HostileHostMachine = { platform: process.platform, arch: process.arch }
): HostileHostCell[] {
  const wanted = (filter ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
  const unknown = wanted.filter((id) => !cells.some((cell) => cell.id === id))
  if (unknown.length > 0) {
    throw new Error(`Unknown hostile-host cells: ${unknown.join(', ')}`)
  }
  // Why: a named cell skipped for the wrong OS or arch would leave its CI job green with no run.
  const unhostable = cells.filter(
    (cell) => wanted.includes(cell.id) && !canRunHostileHostCell(cell, machine)
  )
  if (unhostable.length > 0) {
    throw new Error(
      `Hostile-host cells cannot run on ${machine.platform}-${machine.arch}: ${unhostable.map((cell) => cell.id).join(', ')}`
    )
  }
  return cells.filter(
    (cell) =>
      (wanted.length === 0 || wanted.includes(cell.id)) && canRunHostileHostCell(cell, machine)
  )
}

export type HostileHostObservation = {
  /** The rung the ladder settled on, or null when it never settled. */
  settledRung: SshRemoteRuntimeRung | null
  /** The server target of a launched relay, when the ladder resolved one. */
  target: ServerTarget | null
  /** Set when the deploy failed with the rung D error. */
  unavailableReason: RemoteRuntimeUnavailableReason | null
  deployError: string | null
  refusals: readonly RungRefusal[]
  forbiddenToolCalls: readonly string[]
}

function describeRefusals(refusals: readonly RungRefusal[]): string {
  return refusals.map(({ step, reason }) => `${step}:${reason}`).join(' > ') || 'none'
}

/** Every way `observed` departs from the cell's expectation; empty when the cell holds. */
export function hostileHostCellViolations(
  cell: HostileHostCellCore,
  observed: HostileHostObservation
): string[] {
  const { expect } = cell
  const violations: string[] = []
  const expectedRefusals = expect.outcome === 'legacy_opt_out' ? [] : (expect.refusals ?? [])
  if (describeRefusals(observed.refusals) !== describeRefusals(expectedRefusals)) {
    violations.push(
      `refusals ${describeRefusals(observed.refusals)}, expected ${describeRefusals(expectedRefusals)}`
    )
  }
  // Why every ladder outcome: nothing may install or compile. A version probe is read-only; the
  // host-Node fallback asks `npm --version` before it settles D on a host with no usable npm.
  const toolchainActions = observed.forbiddenToolCalls.filter((call) => !isReadOnlyToolProbe(call))
  if (expect.outcome !== 'legacy_opt_out' && toolchainActions.length > 0) {
    violations.push(`toolchain invoked: ${toolchainActions.join('; ')}`)
  }
  switch (expect.outcome) {
    case 'launched':
      if (observed.deployError) {
        violations.push(`deploy failed: ${observed.deployError}`)
      }
      if (observed.settledRung !== expect.rung) {
        violations.push(`settled on ${observed.settledRung ?? 'nothing'}, expected ${expect.rung}`)
      }
      if (observed.target !== expect.target) {
        violations.push(`target ${observed.target ?? 'unresolved'}, expected ${expect.target}`)
      }
      break
    case 'unavailable':
      if (observed.settledRung !== 'D') {
        violations.push(`settled on ${observed.settledRung ?? 'nothing'}, expected D`)
      }
      if (observed.unavailableReason !== expect.reason) {
        violations.push(
          `rung D reason ${observed.unavailableReason ?? 'none'}, expected ${expect.reason}`
        )
      }
      break
    case 'legacy_opt_out':
      // The host-Node path's own verdict depends on the host's Node, so only the ladder is judged.
      if (observed.settledRung !== null) {
        violations.push(`settled on ${observed.settledRung}, expected the ladder never to run`)
      }
      break
  }
  return violations
}

/** A shim call that only asks a tool its version, as `<tool> --version` or `<tool> -v`. */
export function isReadOnlyToolProbe(call: string): boolean {
  return /^\S+ (?:--version|-v)$/.test(call.trim())
}

export function parseForbiddenToolLog(contents: string): string[] {
  return contents
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

/** Run real managed-orcad deployment against container/loopback host constraints in ssh-hostile-hosts.yml. */
import type { NodeRuntimeTarget } from '../../../shared/node-runtime-pin'
import type { OrcadHostUnavailableReason } from '../../orcad/orcad-host-unavailable'

/** Every shimmed toolchain command appends its name here; a managed deploy must leave it empty. */
export const FORBIDDEN_TOOL_LOG = '/tmp/orca-forbidden-tool-calls.log'
export const FORBIDDEN_TOOLS = ['npm', 'npx', 'node-gyp', 'gcc', 'g++', 'cc', 'c++', 'make']

/** The shim every forbidden tool name links to: it records the call and fails like a missing tool. */
export function forbiddenToolShimScript(logPath: string): string {
  return ['#!/bin/sh', `printf '%s %s\\n' "\${0##*/}" "$*" >> '${logPath}'`, 'exit 127', ''].join(
    '\n'
  )
}

export type HostileHostCellCore = {
  id: string
  managed: ManagedOrcadExpectation
  /** This computer's Node download is refused and its cache is empty, so only the host can fetch it. */
  desktopNoEgress?: boolean
}

export type ManagedOrcadExpectation =
  | { outcome: 'activated'; runtime: NodeRuntimeTarget }
  | { outcome: 'unavailable'; runtime: NodeRuntimeTarget; reason: OrcadHostUnavailableReason }

export type DockerHostileHostCell = HostileHostCellCore & {
  host?: 'docker'
  /** Dockerfile lines, FROM included; the harness appends sshd and the toolchain shims. */
  dockerfile: readonly string[]
  /** Mount `/root` as a noexec tmpfs, the way a hardened host mounts home. */
  homeNoexec?: boolean
  /** Attach only to a `docker network create --internal` network: the host has no egress. */
  noEgress?: boolean
}

/** User-level loopback sshd with shim-only PATH and empty HOME keeps profiles/toolchains from leaking into deployment. */
export type LocalSshdHostileHostCell = HostileHostCellCore & {
  host: 'local-sshd'
  runsOn: { platform: NodeJS.Platform; arch: string }
  extraForbiddenTools?: readonly string[]
}

export type HostileHostCell = DockerHostileHostCell | LocalSshdHostileHostCell

export function isLocalSshdCell(cell: HostileHostCell): cell is LocalSshdHostileHostCell {
  return cell.host === 'local-sshd'
}

export function forbiddenToolsFor(cell: HostileHostCell): string[] {
  return [...FORBIDDEN_TOOLS, ...(isLocalSshdCell(cell) ? (cell.extraForbiddenTools ?? []) : [])]
}

// SFTP uploads carry no quarantine attribute; deployment must run without xattr remediation.
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

// Debian buster packages moved to archive.debian.org.
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
    managed: { outcome: 'activated', runtime: 'linux-x64-glibc' }
  },
  {
    id: 'almalinux8-glibc228',
    dockerfile: [
      `FROM ${ALMALINUX_8}`,
      'RUN dnf install -y openssh-server procps-ng tar gzip && dnf clean all'
    ],
    managed: { outcome: 'activated', runtime: 'linux-x64-glibc' }
  },
  {
    id: 'alpine-musl',
    dockerfile: [`FROM ${ALPINE_3_20}`, `${ALPINE_SSHD} libgcc libstdc++`],
    managed: { outcome: 'activated', runtime: 'linux-x64-musl' }
  },
  {
    // The musl Node links libstdc++, so its self-test fails before orcad can start.
    id: 'alpine-musl-no-libstdcxx',
    dockerfile: [`FROM ${ALPINE_3_20}`, ALPINE_SSHD],
    managed: { outcome: 'unavailable', runtime: 'linux-x64-musl', reason: 'runtime_self_test' }
  },
  {
    // The runtime lands under the noexec home, so its self-test cannot execute it.
    id: 'ubuntu2204-noexec-home',
    dockerfile: [
      `FROM ${UBUNTU_22_04}`,
      'RUN apt-get update' +
        ' && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends openssh-server procps' +
        ' && rm -rf /var/lib/apt/lists/*'
    ],
    homeNoexec: true,
    managed: { outcome: 'unavailable', runtime: 'linux-x64-glibc', reason: 'runtime_noexec' }
  },
  {
    // glibc 2.17 is below the pinned Node's floor, so orcad runs on the glibc 2.17 compat runtime.
    id: 'centos7-glibc217',
    dockerfile: [
      `FROM ${CENTOS_7}`,
      // CentOS7 mirrors are gone; use its end-of-life vault.
      "RUN sed -i -e 's/^mirrorlist=/#mirrorlist=/' -e 's|^#\\?baseurl=http://mirror.centos.org/centos/$releasever|baseurl=http://vault.centos.org/7.9.2009|' /etc/yum.repos.d/CentOS-*.repo" +
        ' && yum install -y openssh-server procps-ng && yum clean all'
    ],
    managed: { outcome: 'activated', runtime: 'linux-x64-glibc217' }
  },
  {
    // The client uploads the runtime over SSH, so a host that cannot reach nodejs.org still runs orcad.
    id: 'debian10-no-egress',
    dockerfile: DEBIAN_10_LINES,
    noEgress: true,
    managed: { outcome: 'activated', runtime: 'linux-x64-glibc' }
  },
  {
    // This computer can't reach nodejs.org, so the host downloads the runtime with its own curl.
    id: 'almalinux8-desktop-no-egress',
    dockerfile: [
      `FROM ${ALMALINUX_8}`,
      'RUN dnf install -y openssh-server procps-ng tar gzip curl && dnf clean all'
    ],
    desktopNoEgress: true,
    managed: { outcome: 'activated', runtime: 'linux-x64-glibc' }
  },
  {
    id: 'macos-arm64-local-sshd',
    host: 'local-sshd',
    runsOn: { platform: 'darwin', arch: 'arm64' },
    extraForbiddenTools: MACOS_FORBIDDEN_TOOLS,
    managed: { outcome: 'activated', runtime: 'darwin-arm64' }
  },
  {
    id: 'macos-x64-local-sshd',
    host: 'local-sshd',
    runsOn: { platform: 'darwin', arch: 'x64' },
    extraForbiddenTools: MACOS_FORBIDDEN_TOOLS,
    managed: { outcome: 'activated', runtime: 'darwin-x64' }
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

/** An explicit cell filter must be hostable here; empty selects every compatible cell. */
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
  // Explicit unhostable cells must fail rather than produce a green empty job.
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

/** Logged toolchain calls that install or compile; a bare `--version`/`-v` probe is read-only. */
export function forbiddenToolActions(log: string): string[] {
  return log
    .split('\n')
    .map((line) => line.trim())
    .filter((call) => call && !/^\S+ (?:--version|-v)$/.test(call))
}

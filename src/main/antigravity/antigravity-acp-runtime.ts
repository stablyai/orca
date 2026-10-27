// No upstream checksums are published; pin each verified archive and executable.

import { join } from 'node:path'
import type { ManagedRuntime, ManagedRuntimePin } from '../node-runtime/managed-runtime-release'
import { probeAntigravityAcpServer } from './antigravity-acp-runtime-probe'

const VERSION = '1.3.0'
const RELEASES = 'https://dl.google.com/agy-extensions/releases'
const COMMAND = 'agy_acp_server.par'
// The server finds its harness beside itself.
const HARNESS = 'localharness_external'

type Pinned = {
  path: string
  archive: string
  archiveBytes: number
  server: string
  serverBytes: number
  harness: string
  harnessBytes: number
}
const PINNED: Record<string, Pinned> = {
  'darwin-arm64': {
    path: 'macos/agy-acp-server-1.3.0-darwin-arm64.zip',
    archive: '7cd97045f7b4fe81175a107cdf16f9c51484e3c78a5162cae415338bb6aa5b88',
    archiveBytes: 111456962,
    server: 'cb1f0725183ed922079ed6cd1d2422b4d8be44c5fb60be3e9a43d8d04f99a18e',
    serverBytes: 278535456,
    harness: 'b04b00662c1821b953a409d43626b86d1229130eeb2078b4e1304c06199aa481',
    harnessBytes: 118611392
  },
  'darwin-x64': {
    path: 'macos/agy-acp-server-1.3.0-darwin-x86_64.zip',
    archive: 'bb23956b89984bf5d354af2c3725e6c57f0cc1b7228e77a0e91c9c2bc1d47646',
    archiveBytes: 117245544,
    server: 'f31bd5797eeb225a5efa12e24573f1f4eb157ec00698dd6a2cda6f0d924705cf',
    serverBytes: 282840688,
    harness: 'd724f49b2c9e440c5d37925b1da203fc204c17dd9c662df45094c641f9806bc6',
    harnessBytes: 124175392
  },
  'linux-x64': {
    path: 'linux/agy-acp-server-1.3.0-linux-x86_64.zip',
    archive: '9fb60956af0a9d76220a4db91ca9ac88e2a2372ad68f985ab5fceace6b825b96',
    archiveBytes: 333727150,
    server: 'cf6feaebdacfc2255dcfc8883db99b15de8554698554e2a1e78e5ccec1c68a20',
    serverBytes: 926533965,
    harness: '63042ca43fc7a69600683920f7706689b82cf8aecefe21dc18cf35e99c9dde4d',
    harnessBytes: 130388040
  },
  'linux-arm64': {
    path: 'linux/agy-acp-server-1.3.0-linux-arm64.zip',
    archive: '500b0bc0fb858e88f4df404d4cedf80bf9298c178291e39e383d6c50b111cbdf',
    archiveBytes: 321690363,
    server: '03ea51ff7a60cb1b44e65da40fdb35f1f457db7950d1651d9e86945c8aa584c6',
    serverBytes: 930848992,
    harness: '7fe676f1234889900800bad3ca50fb9b55f1e16ee4cb82b789f84ae5145fd582',
    harnessBytes: 123224968
  }
}

function pin(): ManagedRuntimePin | null {
  const pinned = PINNED[`${process.platform}-${process.arch}`]
  return pinned
    ? {
        version: VERSION,
        url: `${RELEASES}/${pinned.path}`,
        archiveSha256: pinned.archive,
        archiveBytes: pinned.archiveBytes,
        members: [
          { path: COMMAND, sha256: pinned.server, bytes: pinned.serverBytes },
          { path: HARNESS, sha256: pinned.harness, bytes: pinned.harnessBytes }
        ]
      }
    : null
}

export const ANTIGRAVITY_ACP_COMMAND = COMMAND

export const ANTIGRAVITY_ACP_RUNTIME: ManagedRuntime = {
  label: 'Antigravity',
  root: (dataDirectory) => join(dataDirectory, 'agent-runtimes', 'antigravity'),
  pin,
  validate: (folder, pinned, signal) =>
    probeAntigravityAcpServer(join(folder, COMMAND), pinned.version, signal)
}

// Pin the official registry archives and each executable verified inside them.

import { join } from 'node:path'
import type { ManagedRuntime, ManagedRuntimePin } from '../node-runtime/managed-runtime-release'
import { probeAntigravityAcpServer } from './antigravity-acp-runtime-probe'

const VERSION = '1.4.3'
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
    path: 'macos/agy-acp-server-1.4.3-darwin-arm64.zip',
    archive: 'c57db0a9b8b712daa9c3c17cdb990a61842ea569f279e8bd79d7aa85a303b20b',
    archiveBytes: 114147623,
    server: '1251927db3e21f3d693fd042d6890d82f65eb00587e97f1f3d8f0d798e7f0954',
    serverBytes: 282446160,
    harness: '9e8fdc6e20a3262ca0a771850ca4a8414ca839a642cc964ec5c547cc2c33c200',
    harnessBytes: 122957936
  },
  'darwin-x64': {
    path: 'macos/agy-acp-server-1.4.3-darwin-x86_64.zip',
    archive: '9392dbbdad7f0663dbfb5a0bf641297b0cf80d2ee9cd2d49a616bbbc7378731d',
    archiveBytes: 119801100,
    server: 'd51eea5bdb2c5fa2ca37c21bafcbba1eb89fb6b287489b0c2795c64f3b96ee33',
    serverBytes: 286653712,
    harness: '0c000ad3f4c1ded5fc72b23a8c5816205a09e6d8f0957c9ea548221273e0efd9',
    harnessBytes: 127612208
  },
  'linux-x64': {
    path: 'linux/agy-acp-server-1.4.3-linux-x86_64.zip',
    archive: '0634ce5306ba92c932945455e7a83fda78e2d99c33fa8aa6ee0566206a382714',
    archiveBytes: 336846435,
    server: '7e06ec4aab6dcff53911a16c124692bc95c8848b2a1fd3220be6f67dbe7efafb',
    serverBytes: 927707135,
    harness: '55b2d1d8206d3f38353cdba3c5c5d087cd718241b90500bce4f8009f64495285',
    harnessBytes: 133926136
  },
  'linux-arm64': {
    path: 'linux/agy-acp-server-1.4.3-linux-arm64.zip',
    archive: '05c153443b0b1175151c760eeddea538950bc9843e317d54786a1f03670182bc',
    archiveBytes: 322887047,
    server: '6db15569878613d9abe47f9841a3e039322b0c599c752510ff27381c9532ff21',
    serverBytes: 932662106,
    harness: 'd898fa05e31d502b0b2df5a8565463c2cec0a06a7a65285d49b1ea79c3fc42b3',
    harnessBytes: 127512832
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

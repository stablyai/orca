// Pin the official registry archives and each executable verified inside them.

import { join } from 'node:path'
import type { ManagedRuntime, ManagedRuntimePin } from '../node-runtime/managed-runtime-release'
import { probeAntigravityAcpServer } from './antigravity-acp-runtime-probe'

// 1.4.2 through 1.4.5 are reported to write skills/system/run-workflow/SKILL.md into the chat's
// workspace when a session starts; check a newer release in an empty folder before moving this pin.
const VERSION = process.platform === 'win32' ? '1.4.5' : '1.4.1'
const RELEASES = 'https://dl.google.com/agy-extensions/releases'
const COMMAND = process.platform === 'win32' ? 'agy_acp_server.exe' : 'agy_acp_server.par'
// The server finds its harness beside itself.
const HARNESS = process.platform === 'win32' ? 'localharness_external.exe' : 'localharness_external'

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
    path: 'macos/agy-acp-server-1.4.1-darwin-arm64.zip',
    archive: 'f9bdd68291ae78c38d2141e63bc86b84e6cc7b9f60f71652c68435a7943deb17',
    archiveBytes: 112737434,
    server: 'ee664236c317b38f33fb8d14188c5e32887bf493ab1372f1185cde126a3b130d',
    serverBytes: 280996576,
    harness: 'b5b921d79c849806204901a24cb6a961bf2a689edd8a2e226401c96e368cfb6f',
    harnessBytes: 120246928
  },
  'darwin-x64': {
    path: 'macos/agy-acp-server-1.4.1-darwin-x86_64.zip',
    archive: '27e31f096874704f14167b07ef9e84cc77134615ee41d024f7b1c957add85307',
    archiveBytes: 118349036,
    server: '022ae66dd99e7a6ea17846641963942c72c00bce1c5a32a1ccb32ec889c5023d',
    serverBytes: 285186624,
    harness: 'c6a2c260ca03899e8a3e4fe3279a2f9aa1d701a01721720db73d95ade9dfe511',
    harnessBytes: 124910048
  },
  'linux-x64': {
    path: 'linux/agy-acp-server-1.4.1-linux-x86_64.zip',
    archive: '2e37012ceb2a5c7fc7309b6e6596234fb637ee3c62a5199f65d4cbe777871384',
    archiveBytes: 336170339,
    server: '57e7c4c505fdc8787993d4ff868274f44fd7aa4e4c82cf424fece3bf6c487643',
    serverBytes: 930826753,
    harness: '5ba6f2f24faffa6bceaf9344871ccc8624ebeccb27a7d0d45a9ffdda851d72c7',
    harnessBytes: 131187512
  },
  'linux-arm64': {
    path: 'linux/agy-acp-server-1.4.1-linux-arm64.zip',
    archive: '609336a1c97545487e3ddd55dbd153dc0f40f4e6534486cc1c5f4c0ebb85c2da',
    archiveBytes: 321922507,
    server: '7d3eb1fab7b5b60a545004f91850609ae6c345abceffbd82b4959385069f9ffe',
    serverBytes: 933416796,
    harness: '18bcd9a2ab80b66d90f61add7a52a37f53d3113bb0429a0b92709ed09f32a6e1',
    harnessBytes: 124895000
  },
  'win32-x64': {
    path: 'windows/agy-acp-server-1.4.5-windows-x86_64.zip',
    archive: 'd24f4c73c9f96d4f44384e281c855a56c72d8eaa9c5b0fad7ccb1635c6b63f50',
    archiveBytes: 100423655,
    server: 'ccca30a4aef1b915b0d8baa17b149de6cda305841fa27717e52c529bb462c51d',
    serverBytes: 55839864,
    harness: '98f808f7796c0a06d104715dbef65025e57243106fff5935d9bedd5843f03cda',
    harnessBytes: 147843736
  },
  'win32-arm64': {
    path: 'windows/agy-acp-server-1.4.5-windows-arm64.zip',
    archive: 'ab0a9aac8349e08ef289be6d16da8f89e3abe60eba5158032ef78c4a1220261c',
    archiveBytes: 102703121,
    server: 'c1363f25215a131b0c114d28da9a952b39eef7596408e33cfb3487c87f32ffb2',
    serverBytes: 62293488,
    harness: 'b56aa033e85c3df681e15deb1aaceda8a98e137c55c05a625071b11546d7b840',
    harnessBytes: 139322008
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

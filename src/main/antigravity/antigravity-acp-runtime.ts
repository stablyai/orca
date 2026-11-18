// Pin the official registry archives and each executable verified inside them.

import { join } from 'node:path'
import type { ManagedRuntime, ManagedRuntimePin } from '../node-runtime/managed-runtime-release'
import { probeAntigravityAcpServer } from './antigravity-acp-runtime-probe'

// 1.4.2 and later write skills/system/run-workflow/SKILL.md into the chat's workspace unless the
// session disables run_workflow; check a newer release in an empty folder before moving this pin.
const VERSION = '1.5.0'
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
    path: 'macos/agy-acp-server-1.5.0-darwin-arm64.zip',
    archive: 'c82ecb4ef476bfc35cbe5b2745cdddef873b99c9f5bd7fd11e5ca1fc1667a3fc',
    archiveBytes: 100401185,
    server: 'bbb138a7ff32982e231af325e3176b252174f4c59e4fee7159c0e364ad5f9613',
    serverBytes: 179756208,
    harness: '4eddc5c77a0bb275372fb548a9011a1acc70828a4a72412f2da0733c90db30fe',
    harnessBytes: 129572384
  },
  'darwin-x64': {
    path: 'macos/agy-acp-server-1.5.0-darwin-x86_64.zip',
    archive: '86a94e33b25d4a38ff30526ad844546860aa9ed98698498d9e87d30eb794426e',
    archiveBytes: 106461356,
    server: 'b60b713917ce0db322cae7a8d9fcdcd93f1515e7242880592fc23297bc652357',
    serverBytes: 184151792,
    harness: '30e1cfdcd0349e8cb642c90bd847825ec762f9c1cf2d52e1093535f368003c32',
    harnessBytes: 134730544
  },
  'linux-x64': {
    path: 'linux/agy-acp-server-1.5.0-linux-x86_64.zip',
    archive: '36f373e8948edf1727b39c7d62b5722d6a4474bdfd72b04ad3d6def571808c9f',
    archiveBytes: 274069093,
    server: '8a35f63dd2284e3790a1d97dd0cb2236057c55a0c598b26f3bde022b843d5c04',
    serverBytes: 714224576,
    harness: '13dca92307524722a3434cd50baba3f33502d71a24f804f03ee2efbd18b6017d',
    harnessBytes: 139570072
  },
  'linux-arm64': {
    path: 'linux/agy-acp-server-1.5.0-linux-arm64.zip',
    archive: '1e184f439477b54138e94440056b26a78c0a8075a8fd2ffda637ec31267c6459',
    archiveBytes: 264366319,
    server: '4437a73922a11a67c0185f4b709cb685cf67ae6d56e2ffe9cc29062a99befb20',
    serverBytes: 721489411,
    harness: '485cb7d96d06ce732d841713e5166d07f4053e8c4aaf31a31f6204ee8d024eb2',
    harnessBytes: 132951888
  },
  'win32-x64': {
    path: 'windows/agy-acp-server-1.5.0-windows-x86_64.zip',
    archive: '6163f6b59b381bae419652dbae167bc8cda0ef29d665c0ba8af3d8c7fddd8867',
    archiveBytes: 105513364,
    server: '209a30dee3f67fbb62710263d38323dc0d66b71b5121eb37ea80b63383dd178a',
    serverBytes: 58314376,
    harness: '4e3644c05a601fd8da1cc9e72639e857d3a7c78f3d2cdf48ea7805ce4a3263ab',
    harnessBytes: 155782808
  },
  'win32-arm64': {
    path: 'windows/agy-acp-server-1.5.0-windows-arm64.zip',
    archive: '340092b8af6dafc71eb15f4a8ec54b4d1f0bce16d1fa4d163b562c50b905f8f4',
    archiveBytes: 108145235,
    server: '2acaf9e80de0e979c214fc7c00427dd2791469e1a446fe8c545bcb5d8745a7f4',
    serverBytes: 65077040,
    harness: '4ca67a6d4472c06a09aec01dece2f6001ba6c88002e7a3a14ee7520f25d1a951',
    harnessBytes: 147104920
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

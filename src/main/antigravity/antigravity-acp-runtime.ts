// Pin the official registry archives and each executable verified inside them.

import { join } from 'node:path'
import type { ManagedRuntime, ManagedRuntimePin } from '../node-runtime/managed-runtime-release'
import { probeAntigravityAcpServer } from './antigravity-acp-runtime-probe'

// 1.4.2 and later write skills/system/run-workflow/SKILL.md into the chat's workspace unless the
// session disables run_workflow; check a newer release in an empty folder before moving this pin.
const VERSION = '1.5.2'
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
    path: 'macos/agy-acp-server-1.5.2-darwin-arm64.zip',
    archive: '123a16d5c40a8ac99e20f01a62b68dd860fd96b1c528dfb8eaa37ca8733d4845',
    archiveBytes: 100309778,
    server: '4cea3c96875a4bb66a1c136d972b5cfdc5f7c91579ff7b9cbfc158a4358270bc',
    serverBytes: 179921328,
    harness: '31ec5f444b8c849ddb14da1c0893a87dddab60f1d5e282b79db36dc41b2521ab',
    harnessBytes: 129208672
  },
  'darwin-x64': {
    path: 'macos/agy-acp-server-1.5.2-darwin-x86_64.zip',
    archive: '92addb5580577b5356d35484d72d1a113d9c5312ad766bcb304983aa8e3fbb06',
    archiveBytes: 106351992,
    server: 'eaeea2dcd5d162ad075de71fc902d9a3d63116ec5452d81798e30b3c06c6df37',
    serverBytes: 184312784,
    harness: '72530625a54510fdba6746c0c4b461f9b1c3222163b0c595f0ed7df660cb6134',
    harnessBytes: 134350320
  },
  'linux-x64': {
    path: 'linux/agy-acp-server-1.5.2-linux-x86_64.zip',
    archive: '99dd8612450805011619d7b8447ce374c289e00549d8557f36790e1dd6256852',
    archiveBytes: 273964075,
    server: 'f472860b79c4816a32817e589afdb01cec0ca731e5fa428eae873b14be12387f',
    serverBytes: 714384320,
    harness: '072fc497e7814b0e25a7d80109bceddacd815eb351d2e48ce579a05510e0cfdf',
    harnessBytes: 139194456
  },
  'linux-arm64': {
    path: 'linux/agy-acp-server-1.5.2-linux-arm64.zip',
    archive: 'e729e05ef54ef0763e48900032466b47fa7c9939cde257f93ba49410ab577acb',
    archiveBytes: 264270419,
    server: '748dda64d889552943b5527c78aa2804b4e2b9fed7501ae63eb0890ad539380e',
    serverBytes: 721649155,
    harness: '06b2fcf3c20d76cec15fc9db952731a2058356311e0760cb818feeabca6d6f91',
    harnessBytes: 132598576
  },
  'win32-x64': {
    path: 'windows/agy-acp-server-1.5.2-windows-x86_64.zip',
    archive: '5cbadd4f4df698572473d8890fc26ec2dc1724501f06e3a963941daec2bd21d6',
    archiveBytes: 105407645,
    server: '722d5677f5547e49e2f4796d21ae1d638e0186ec0ecd49b69b12ed6a2de81e54',
    serverBytes: 58368800,
    harness: 'afc584c54d1a1826d4c430a580d5df12d4bd297eb6ca57e4a8116cf4de72c307',
    harnessBytes: 155357336
  },
  'win32-arm64': {
    path: 'windows/agy-acp-server-1.5.2-windows-arm64.zip',
    archive: '8a4b2ea8df2ffefae33309348752e9119d21a6d36090c0eb48631c2e8f5781ab',
    archiveBytes: 108049351,
    server: '1d0e8de59edc7f22edc1b3a1ebc9569b331eda6ec249471c0115a70a97b71b46',
    serverBytes: 65130848,
    harness: '88ca79bc3fc76e97ef8a68cd3e7b4b6c503bbf135f2cbca5bc00ec3c02125f05',
    harnessBytes: 146707096
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

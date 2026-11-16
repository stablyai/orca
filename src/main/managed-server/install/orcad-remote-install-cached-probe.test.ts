import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ExecCommandModule from '../../ssh/remote-exec/remote-exec-command'
import { runProcess } from '@orca/process-host'

vi.mock('../../ssh/remote-exec/remote-exec-command', async (importOriginal) => ({
  ...(await importOriginal<typeof ExecCommandModule>()),
  execCommand: vi.fn()
}))

import { execCommand } from '../../ssh/remote-exec/remote-exec-command'
import { pinnedNodeRuntimeAsset } from '../../../shared/node-runtime/node-runtime-pin'
import { getRemoteHostPlatform } from '../../ssh/remote-host/ssh-remote-platform'
import type { OrcadHostTransport } from './orcad-host-transport'
import { readCachedOrcadSlotState } from './orcad-remote-install-cached-probe'
import { remoteNodeRuntimeDir } from './orcad-remote-node-runtime'
import {
  recordedNodeRuntimeProbeCommand,
  REMOTE_NODE_RUNTIME_HASHED_STAT_FILENAME
} from './orcad-remote-node-runtime-recorded-probe'
import { ORCAD_INSTALL_MODEL } from './remote-install-model'

const host = getRemoteHostPlatform('linux-x64')
const target = 'linux-x64-glibc'
let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-cached-slot-'))
  vi.mocked(execCommand).mockImplementation(async (_conn, command) => {
    const result = await runProcess({ program: '/bin/sh', args: ['-c', command] })
    return result.stdout
  })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe.skipIf(process.platform === 'win32')('the cached slot probe', () => {
  // A record whose stat signature still matches must not stand in for the hash on SSH.
  it('hashes an SSH host runtime even when a recorded signature matches it', async () => {
    const slotDir = join(root, 'orcad-0.1.0+aaaaaaaaaaaa')
    for (const filename of [
      ...ORCAD_INSTALL_MODEL.requiredArtifacts(host),
      ORCAD_INSTALL_MODEL.installCompleteFilename
    ]) {
      mkdirSync(join(slotDir, filename, '..'), { recursive: true })
      writeFileSync(join(slotDir, filename), '')
    }
    const runtimeDir = remoteNodeRuntimeDir(host, slotDir, target)
    const executable = join(runtimeDir, 'bin', 'node')
    mkdirSync(join(runtimeDir, 'bin'), { recursive: true })
    writeFileSync(executable, '#!/bin/sh\n', { mode: 0o755 })
    writeFileSync(join(runtimeDir, '.verified'), '')
    // The recorded probe signs these bytes under their own digest; re-key that record to the pin.
    const ownDigest = createHash('sha256').update('#!/bin/sh\n').digest('hex')
    await runProcess({
      program: '/bin/sh',
      args: ['-c', recordedNodeRuntimeProbeCommand(host, runtimeDir, ownDigest)]
    })
    const record = join(runtimeDir, REMOTE_NODE_RUNTIME_HASHED_STAT_FILENAME)
    writeFileSync(
      record,
      readFileSync(record, 'utf8').replace(
        ownDigest,
        pinnedNodeRuntimeAsset(target).executableSha256
      )
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: execCommand is mocked, so the transport is never used.
    const conn = Object.create(null) as OrcadHostTransport
    const probe = (recordedNodeRuntimeProbe: boolean) =>
      readCachedOrcadSlotState({ conn, host, target, recordedNodeRuntimeProbe }, slotDir)

    expect(await probe(true)).toEqual({ runtimeReady: true, slotComplete: true })
    expect(await probe(false)).toEqual({ runtimeReady: false, slotComplete: true })
  })
})

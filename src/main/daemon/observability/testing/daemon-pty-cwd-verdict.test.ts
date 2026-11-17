import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../telemetry/client', () => ({ track: vi.fn() }))

import type { DaemonEndpointIdentity } from '../../protocol/daemon-hello-protocol'
import {
  getDaemonFolderAccessMismatch,
  resetDaemonFolderAccessMismatchForTests
} from '../../permissions/daemon-folder-access-mismatch'
import { reportDaemonPtyCwdVerdict } from '../daemon-adoption-telemetry-event'

const HELPER: DaemonEndpointIdentity = { pid: 1530, startedAtMs: 1_700_000, launchNonce: 'n1' }
const NEXT_HELPER: DaemonEndpointIdentity = { pid: 1531, startedAtMs: 1_700_500, launchNonce: 'n2' }
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
let folder = ''

function verdict(
  cwd: string,
  cwdReadableByDaemon: boolean,
  daemonIdentity = HELPER
): Promise<void> {
  return reportDaemonPtyCwdVerdict({ cwd, cwdReadableByDaemon, pidPath: null, daemonIdentity })
}

beforeEach(async () => {
  resetDaemonFolderAccessMismatchForTests()
  // The app-side recheck only runs on macOS; the verdict rules themselves are platform-free.
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
  folder = await mkdtemp(join(tmpdir(), 'orca-cwd-verdict-'))
})
afterEach(async () => {
  Object.defineProperty(process, 'platform', platform)
  await rm(folder, { recursive: true, force: true })
})

describe('helper folder verdicts', () => {
  it('shows the notice only for the helper that was denied a folder this app can read', async () => {
    await verdict(folder, false)
    expect(getDaemonFolderAccessMismatch(HELPER)).not.toBeNull()
    expect(getDaemonFolderAccessMismatch(NEXT_HELPER)).toBeNull()
  })

  it('clears the notice once that helper reads the folder again', async () => {
    await verdict(folder, false)
    await verdict(folder, true)
    expect(getDaemonFolderAccessMismatch(HELPER)).toBeNull()
  })

  it('shows no notice when this app cannot read the folder either', async () => {
    await verdict(join(folder, 'missing'), false)
    expect(getDaemonFolderAccessMismatch(HELPER)).toBeNull()
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => Promise<never>>())
const call = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => Promise<never>) =>
      handlers.set(channel, fn),
    removeHandler: vi.fn()
  }
}))
vi.mock('./hosted-workspace-service', () => ({
  // This computer's record still says running: archived or put to sleep elsewhere.
  findCloudRuntime: () => ({
    sandboxId: 'sbx_1',
    runtime: { status: 'running', runtimeEnvironmentId: 'env-1', repoId: 'r', repoPath: '/r' }
  })
}))
vi.mock('./hosted-runtime-environment-call', () => ({
  createHostedRuntimeEnvironmentCall: () => call
}))

import { ORCA_CLOUD_TRANSFER_CHANNELS as CH } from '../../shared/hosted-sandbox/cloud-transfer-api'
import { installCloudTransferHandlers } from './cloud-transfer'
import { setCloudArchiveCheck } from './hosted-workspace-runtime'
import { setCloudAsleepCheck } from './hosted-remote-sleep'

type PrepareAnswer = { ok: boolean; code?: string }

async function prepare(): Promise<PrepareAnswer> {
  const answer: PrepareAnswer = await handlers.get(CH.prepare)!({}, { workspaceId: 'ws-1' })
  return answer
}

describe('Move to this computer: prepare asks Orca Cloud, not only the local record', () => {
  beforeEach(() => {
    handlers.clear()
    call.mockReset()
    installCloudTransferHandlers({ userDataPath: '/tmp/orca-test-transfer', windows: () => [] })
  })

  it('an archived workspace answers archived instead of packing in its stopped VM', async () => {
    setCloudArchiveCheck(async () => true)
    setCloudAsleepCheck(async () => false)
    expect(await prepare()).toMatchObject({ ok: false, code: 'archived' })
    expect(call).not.toHaveBeenCalled()
  })

  it('one asleep on Orca Cloud answers asleep, so the window wakes it first', async () => {
    setCloudArchiveCheck(async () => false)
    setCloudAsleepCheck(async () => true)
    expect(await prepare()).toMatchObject({ ok: false, code: 'asleep' })
    expect(call).not.toHaveBeenCalled()
  })
})

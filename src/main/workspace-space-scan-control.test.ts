import { describe, expect, it } from 'vitest'
import {
  WorkspaceSpaceScanCancelledError,
  createWorkspaceSpaceScanLimiter
} from './workspace-space-scan-control'

describe('workspace space scan boundaries', () => {
  it('rejects queued work with the public cancellation error', async () => {
    const controller = new AbortController()
    const limit = createWorkspaceSpaceScanLimiter(1, controller.signal)
    let release!: () => void
    const active = limit(() => new Promise<void>((resolve) => (release = resolve)))
    const queued = limit(async () => undefined)
    controller.abort()
    await expect(queued).rejects.toBeInstanceOf(WorkspaceSpaceScanCancelledError)
    release()
    await active
  })
})

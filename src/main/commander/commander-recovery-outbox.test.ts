import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, vi } from 'vitest'
import { RecoveryOutbox } from './commander-recovery-outbox'

it('recovers the newest offline checkpoint after restart without losing the initial goal', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orca-recovery-outbox-'))
  const pageId = 'handoff-00000000-0000-4000-8000-000000000001'
  const entry = { pageId, projectId: 'github:owner/repo', title: 'Fix the crash', body: 'Started' }
  const offline = vi.fn(async () => {
    throw new Error('offline')
  })
  const failed = vi.fn()
  const first = new RecoveryOutbox(directory, offline, failed)
  const sent = vi.fn(async () => {})
  const second = new RecoveryOutbox(directory, sent, () => {})
  try {
    await first.put(entry)
    await vi.waitFor(() => expect(failed).toHaveBeenCalled())
    await first.put({ ...entry, title: 'Continue', body: 'Found the cause' })
    await first.stop()
    second.wake()
    await vi.waitFor(() => expect(sent).toHaveBeenCalledWith({ ...entry, body: 'Found the cause' }))
  } finally {
    await first.stop()
    await second.stop()
    await rm(directory, { force: true, recursive: true })
  }
})

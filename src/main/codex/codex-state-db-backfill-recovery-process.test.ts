import { expect, it, vi } from 'vitest'
import { createFakePipedChild } from '../../shared/__fixtures__/fake-spawned-child'
import { spawnManagedProviderProcess } from '../provider-process/managed-provider-process'
import { stopCodexBackfillRecoveryProcess } from './codex-state-db-backfill-recovery-process'

it('awaits the retained owner close instead of stopping only the backfill root', async () => {
  const child = createFakePipedChild()
  const managed = spawnManagedProviderProcess(
    { command: 'fixture', args: [] },
    {
      site: 'backfill-test',
      platform: 'win32',
      spawnImpl: () => child
    }
  )
  const close = vi.spyOn(managed, 'close').mockResolvedValue({ root: 'exited', tree: 'exited' })
  await stopCodexBackfillRecoveryProcess(child, managed)
  expect(close).toHaveBeenCalledOnce()
})

import type { PtySpawnResult } from '../../../providers/types'
import {
  attachStablePaneOwner,
  capturePtyOutputBoundary,
  type PtyOutputBoundary,
  type StablePaneOwner,
  type StablePaneSpawnContext
} from './stable-owner'

export async function spawnForStablePane(args: StablePaneSpawnContext): Promise<{
  result: PtySpawnResult
  owner: StablePaneOwner | null
  outputBoundary: PtyOutputBoundary
}> {
  if (args.owner) {
    const attached = await attachStablePaneOwner({ ...args, owner: args.owner })
    if (attached) {
      return attached
    }
  }
  const outputBoundary = capturePtyOutputBoundary(
    args.runtime,
    args.expectedPtyId ?? args.spawnOptions.sessionId
  )
  const result = await args.provider.spawn(args.spawnOptions)
  args.onFreshSpawn?.(result)
  return { result, owner: null, outputBoundary }
}

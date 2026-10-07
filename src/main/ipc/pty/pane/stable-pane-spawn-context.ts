import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import type { Store } from '../../../persistence'
import type { IPtyProvider, PtySpawnOptions, PtySpawnResult } from '../../../providers/types'
import type { StablePaneOwner } from './stable-owner'

export type StablePaneSpawnContext = {
  runtime: OrcaRuntimeService | undefined
  store?: Store
  provider: IPtyProvider
  spawnOptions: PtySpawnOptions
  owner: StablePaneOwner | null
  worktreeId?: string
  connectionId?: string | null
  resolveOwner?: () => StablePaneOwner | null
  onBeforeFreshSpawn?: () => void
  onFreshSpawn?: (result: PtySpawnResult) => void
}

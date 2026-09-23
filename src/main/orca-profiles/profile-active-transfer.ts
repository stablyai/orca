import type {
  TransferOrcaProfileProjectArgs,
  TransferOrcaProfileProjectResult
} from '../../shared/orca-profiles'
import type { Store } from '../persistence/loading-store/store'
import { transferOrcaProfileProject } from './profile-project-transfer'
import { hasOrcaProfileStateDatabase } from './profile-storage-paths'
import { profileHasPendingProjectMove } from './profile-project-move-intent'

/** The caller flushes its active Store before this synchronous disk mutation begins. */
export async function transferActiveProfileProject(
  args: TransferOrcaProfileProjectArgs,
  userDataPath: string,
  store: Pick<Store, 'freezeWrites'>,
  reopenSource: () => Promise<void>
): Promise<TransferOrcaProfileProjectResult> {
  const hadDatabase = hasOrcaProfileStateDatabase(args.sourceProfileId, userDataPath)
  try {
    if (profileHasPendingProjectMove(args.sourceProfileId, userDataPath)) {
      throw new Error('active_source_orca_profile_move_requires_recovery')
    }
    return transferOrcaProfileProject(args, userDataPath)
  } catch (error) {
    if (
      (!hadDatabase && hasOrcaProfileStateDatabase(args.sourceProfileId, userDataPath)) ||
      profileHasPendingProjectMove(args.sourceProfileId, userDataPath)
    ) {
      // Further writes would invalidate a retained move's recovery revision.
      store.freezeWrites()
      await reopenSource()
    }
    throw error
  }
}

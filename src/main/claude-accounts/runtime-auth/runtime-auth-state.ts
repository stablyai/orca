import type { Store } from '../../persistence'
import { ClaudeRuntimePathResolver } from '../runtime-paths'

export class ClaudeRuntimeAuthState {
  protected readonly pathResolver = new ClaudeRuntimePathResolver()
  protected mutationQueue: Promise<unknown> = Promise.resolve()
  protected lastSyncedAccountId: string | null = null
  // Why: creds Orca last wrote to the shared file; a mismatch on managed→default transition means an external login overwrote it, so adopt it as the new default.
  protected lastWrittenCredentialsJson: string | null = null
  // Connector revocations require a baseline that reached every runtime store, not a partial file write.
  protected lastWrittenSharedCredentialsJson: string | null = null
  protected hasMaterializedRuntimeAuth = false
  protected hasLastWrittenOauthAccount = false
  protected lastWrittenOauthAccount: unknown = null
  protected skipNextReadBackForAccountId: string | null = null
  protected managedRefreshDeferredByLivePtyAccountId: string | null = null

  protected constructor(protected readonly store: Pick<Store, 'getSettings' | 'updateSettings'>) {}
}

import {
  connectBitbucket,
  disconnectBitbucket,
  getBitbucketConnectionStatus
} from '../../../bitbucket/credential-connection'
import { _resetPreflightCache } from '../../../preflight/agent-detection'
import type {
  BitbucketConnectArgs,
  BitbucketConnectResult,
  BitbucketConnectionStatus
} from '../../../../shared/bitbucket/bitbucket-credentials'

/** Stores and reads Bitbucket credentials for clients of this host, exactly like the host's own Settings IPC (#50700). */
export class RuntimeBitbucketCommands {
  async bitbucketConnect(args: BitbucketConnectArgs): Promise<BitbucketConnectResult> {
    const result = await connectBitbucket(args)
    if (result.ok) {
      // Refresh cached source-control preflight so reconnection needs no relaunch.
      _resetPreflightCache()
    }
    return result
  }

  async bitbucketDisconnect(): Promise<{ ok: true }> {
    await disconnectBitbucket()
    _resetPreflightCache()
    return { ok: true }
  }

  async bitbucketStatus(): Promise<BitbucketConnectionStatus> {
    return getBitbucketConnectionStatus()
  }
}

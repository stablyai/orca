// The teammate's side of the shares routes on Orca Cloud: the agents shared with this account, an
// accept for one, and a message held for a host that is away.
import {
  ConnectorShareAcceptSchema,
  ConnectorShareHoldSchema,
  ConnectorSharesMineSchema,
  sharePath,
  type ConnectorShareAcceptRequest,
  type ConnectorShareHoldRequest
} from '../../../shared/connector-share-contract'
import { CONNECTOR_PATHS } from '../../../shared/connectors/connector-cloud-paths'
import type { ConnectorCloud } from '../../connector-cloud/connector-cloud'

export function sharedBotsCloud(cloud: Pick<ConnectorCloud, 'call'>) {
  return {
    mine: () =>
      cloud.call(`${CONNECTOR_PATHS.shares}/mine`, undefined, ConnectorSharesMineSchema, {
        method: 'GET'
      }),
    accept: (shareId: string, request: ConnectorShareAcceptRequest) =>
      cloud.call(sharePath(shareId, 'accept'), request, ConnectorShareAcceptSchema),
    hold: (shareId: string, request: ConnectorShareHoldRequest) =>
      cloud.call(sharePath(shareId, 'messages'), request, ConnectorShareHoldSchema)
  }
}

export type SharedBotsCloud = ReturnType<typeof sharedBotsCloud>

/** Whether the signed-in account's Orca Cloud takes shares; null until it answers. Another account
 *  starts unknown, so it never keeps the last account's answer through a failed read. */
export class CloudSharesSupport {
  value: boolean | null = null
  private readAs: string | null = null

  constructor(private readonly account: () => string | null) {}

  /** Drops another account's answer once a different account (or none) is signed in, at once, even
   *  while a read made as the last one is still out; `forgot` hears when one was dropped. */
  forgetIfSwitched(forgot: () => void): void {
    const account = this.account()
    if (account === this.readAs) {
      return
    }
    this.readAs = account
    const known = this.value
    this.value = null
    if (known !== null) {
      forgot()
    }
  }

  /** Reads the shares route as the signed-in account. An answer counts only while the account it was
   *  read as is still signed in. */
  async read(cloud: SharedBotsCloud | null, forgot: () => void) {
    this.forgetIfSwitched(forgot)
    const account = this.readAs
    const answer = cloud ? await cloud.mine() : null
    if (this.account() === account && this.readAs === account) {
      this.value = sharesSupported(answer, this.value)
    }
    return answer
  }
}

/** A shares answer says the cloud takes shares; a 404 (an older cloud), a sign-out or no cloud says it
 *  doesn't; anything else (no answer, a 5xx) leaves what was known. */
export function sharesSupported(
  answer: Awaited<ReturnType<SharedBotsCloud['mine']>> | null,
  known: boolean | null
): boolean | null {
  if (!answer || answer.ok) {
    return answer !== null
  }
  return answer.error === 'signed_out' || answer.status === 404 ? false : known
}

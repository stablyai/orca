// The shares offered to a paired computer's account, which wait for Accept or Decline. The phone
// answers through that computer, as its own answer: nothing of a share is paired before Accept.
import {
  SHARED_BOTS_PHONE_ACCEPT_METHOD,
  SHARED_BOTS_PHONE_DECLINE_METHOD,
  SharedBotsPhoneAnswer
} from '../../../../src/shared/bots/bot-share-phone'
import type { UnvalidatedRpcRequestPort } from '../../transport/rpc/unvalidated-rpc-request-port'

/** Whether the computer took the phone's Accept or Decline of `shareId`; once it did, its shares are
 *  followed again (`followAgain`) before this answers. */
export async function answerComputerRequest(
  client: UnvalidatedRpcRequestPort,
  shareId: string,
  accept: boolean,
  followAgain: () => Promise<void>
): Promise<boolean> {
  const method = accept ? SHARED_BOTS_PHONE_ACCEPT_METHOD : SHARED_BOTS_PHONE_DECLINE_METHOD
  const answer = await client.sendRequest(method, { shareId }).catch(() => null)
  const answered =
    answer?.ok === true && SharedBotsPhoneAnswer.safeParse(answer.result).data?.answered === true
  if (answered) {
    await followAgain()
  }
  return answered
}

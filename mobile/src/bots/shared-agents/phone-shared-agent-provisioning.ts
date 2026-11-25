// A paired computer's shared agents, as its phone keeps them: each listed one gets a key of the phone's
// own, asked for through the computer; one the computer no longer lists is forgotten. The phone makes
// its keys and share credential here; only their public halves and the credential's hash leave it.
import nacl from 'tweetnacl'
import {
  SHARED_BOTS_PHONE_LIST_METHOD,
  SHARED_BOTS_PHONE_PROVISION_METHOD,
  SharedBotPhoneGrant,
  SharedBotsPhoneList,
  type SharedBotPhoneShare
} from '../../../../src/shared/bots/bot-share-phone'
import { openBotTeamShareOffer } from '../../../../src/shared/bots/bot-team-share-seal'
import {
  hashRelayCredential,
  mintRelayCredential
} from '../../../../src/shared/remote-runtime/relay/relay-credential-hash'
import { MOBILE_PAIRED_E2EE_PRIMITIVES as PRIMITIVES } from '../../transport/encryption/mobile-paired-e2ee-primitives'
import type { UnvalidatedRpcRequestPort } from '../../transport/rpc/unvalidated-rpc-request-port'
import type { PhoneSharedAgent, PhoneSharedAgentStore } from './phone-shared-agent-store'
import type { SharedBotHostView } from '../../../../src/shared/bots/shared-bot-hosts'

type Computer = { pairedHostId: string; client: UnvalidatedRpcRequestPort }

/** A listed share the phone has no key to yet: shown, unreachable, nothing held, until a key comes. */
export function awaitingKeyView(share: SharedBotPhoneShare): SharedBotHostView {
  return {
    environmentId: share.environmentId,
    shareId: share.shareId,
    botId: share.botId,
    botName: share.botName,
    ownerName: share.ownerName,
    homeWorkspaceId: null,
    link: 'unpaired',
    holds: false,
    held: []
  }
}

// A computer away doesn't hold its follow (and every later one) until it is back.
const LIST_READ_OPTIONS = { timeoutMs: 15_000, budgetSpansConnect: true }

/** The computer's list, or null when it gave none (offline, or too old to list shared agents). */
export async function readComputerShares(computer: Computer): Promise<SharedBotsPhoneList | null> {
  const answer = await computer.client
    .sendRequest(SHARED_BOTS_PHONE_LIST_METHOD, undefined, LIST_READ_OPTIONS)
    .catch(() => null)
  return answer?.ok ? (SharedBotsPhoneList.safeParse(answer.result).data ?? null) : null
}

/** Keeps exactly the shares the computer lists under it; asks for a key to each new one. */
export async function syncComputerShares(
  store: PhoneSharedAgentStore,
  computer: Computer,
  shares: readonly SharedBotPhoneShare[],
  needsKey: (entry: PhoneSharedAgent) => boolean
): Promise<void> {
  const listed = new Set(shares.map((share) => share.shareId))
  store.remove(
    new Set(
      store
        .list()
        .filter((entry) => entry.pairedHostId === computer.pairedHostId)
        .filter((entry) => !listed.has(entry.shareId))
        .map((entry) => entry.shareId)
    )
  )
  for (const share of shares) {
    const kept = store.get(share.shareId)
    if (kept && kept.pairedHostId === computer.pairedHostId && !needsKey(kept)) {
      store.put({ ...kept, botName: share.botName, ownerName: share.ownerName })
      continue
    }
    const provisioned = await provisionPhoneKey(computer, share, kept)
    if (provisioned) {
      store.put(provisioned)
    }
  }
}

/**
 * The share's offer through the computer; null when it gave none. A key kept from before asks again
 * with the same key and credential, so the host renews its one row (its invite lapsed unused) and
 * messages it already signed still land; otherwise both are made here.
 */
async function provisionPhoneKey(
  computer: Computer,
  share: SharedBotPhoneShare,
  kept: PhoneSharedAgent | undefined
): Promise<PhoneSharedAgent | null> {
  const deviceKey = kept?.deviceKey ?? newDeviceKey()
  const credential = kept?.credential ?? mintRelayCredential(PRIMITIVES.randomBytes).token
  const seal = PRIMITIVES.generateKeyPair()
  const answer = await computer.client
    .sendRequest(SHARED_BOTS_PHONE_PROVISION_METHOD, {
      shareId: share.shareId,
      devicePublicKey: deviceKey.publicKeyB64,
      sealKey: PRIMITIVES.encodeBase64(seal.publicKey),
      credentialHash: hashRelayCredential(credential)
    })
    .catch(() => null)
  const grant = answer?.ok ? SharedBotPhoneGrant.safeParse(answer.result).data : undefined
  const offer =
    grant &&
    openBotTeamShareOffer(PRIMITIVES, {
      sealSecretKey: seal.secretKey,
      sealed: grant.sealedOffer,
      expect: { botId: share.botId }
    })
  // Only an offer under the host key the computer pinned, which held messages are sealed to.
  if (!grant || !offer || offer.hostPublicKeyB64 !== grant.hostKey) {
    return null
  }
  return {
    pairedHostId: computer.pairedHostId,
    shareId: grant.shareId,
    botId: grant.botId,
    botName: grant.botName,
    ownerName: grant.ownerName,
    environmentId: grant.environmentId,
    connectorOrigin: grant.connectorOrigin,
    hostKey: grant.hostKey,
    // Kept across a new key: they wait on the same host, under the same share.
    held: kept?.held ?? [],
    deviceKey,
    credential,
    offer
  }
}

function newDeviceKey(): PhoneSharedAgent['deviceKey'] {
  const device = nacl.sign.keyPair.fromSeed(PRIMITIVES.randomBytes(32))
  return {
    publicKeyB64: PRIMITIVES.encodeBase64(device.publicKey),
    secretKeyB64: PRIMITIVES.encodeBase64(device.secretKey)
  }
}

// The agents shared with the accounts of the computers this phone is paired to. The phone reaches each
// agent's host on its own, over Orca Relay with its own key, so they keep working while the computer is
// off; a message to a host that is away is held in Orca Cloud with the phone's share credential.
import nacl from 'tweetnacl'
import {
  SHARED_BOT_UNSHARED_MESSAGE,
  sharedBotHostView,
  type SharedBotHostView
} from '../../../../src/shared/bots/shared-bot-hosts'
import type { RpcResponse } from '../../../../src/shared/remote-runtime/rpc/rpc-response-shape'
import type { SharedHostRelayCredential } from '../../../../src/shared/remote-runtime/relay/client/shared-host-relay-connection'
import {
  SharedHostRelayLink,
  type SharedHostLink
} from '../../../../src/shared/remote-runtime/relay/client/shared-host-relay-link'
import { MOBILE_PAIRED_E2EE_PRIMITIVES as PRIMITIVES } from '../../transport/encryption/mobile-paired-e2ee-primitives'
import { MOBILE_RELAY_CLIENT_PLATFORM } from '../../transport/encryption/mobile-relay-client-platform'
import { MOBILE_RUNTIME_CLIENT_CAPABILITIES } from '../../transport/connection/mobile-runtime-client-capabilities'
import type { UnvalidatedRpcRequestPort } from '../../transport/rpc/unvalidated-rpc-request-port'
import { randomV4Uuid } from '../../platform/random-v4-uuid'
import {
  heldSendFailure,
  sharedAgentOffline,
  sharedAgentUnshared
} from './phone-shared-agent-failures'
import { PhoneSharedAgentFollows } from './phone-shared-agent-follows'
import { PhoneSharedAgentHeld } from './phone-shared-agent-held'
import { PhoneSharedAgentHeldPoll } from './phone-shared-agent-held-poll'
import { PhoneSharedAgentKeptReads } from './phone-shared-agent-kept-reads'
import {
  awaitingKeyView,
  readComputerShares,
  syncComputerShares
} from './phone-shared-agent-provisioning'
import { PhoneSharedAgentStore, type PhoneSharedAgent } from './phone-shared-agent-store'
import type { SharedBotPhoneShare } from '../../../../src/shared/bots/bot-share-phone'

type Link = SharedHostRelayLink<PhoneSharedAgent>
type Computer = { pairedHostId: string; client: UnvalidatedRpcRequestPort }

/** How the phone reaches the host with what it keeps: its resume credential, else an unexpired invite
 *  the relay hasn't refused; null when only a fresh key (through the computer) would. */
export function phoneSharedAgentCredential(
  entry: PhoneSharedAgent,
  now: number
): SharedHostRelayCredential | null {
  if (entry.resume) {
    return { kind: 'resume', token: entry.resume.token, version: entry.resume.version }
  }
  const { relay } = entry.offer
  return relay.inviteExpiresAt > now && relay.inviteToken !== entry.refusedInvite
    ? { kind: 'invite', inviteToken: relay.inviteToken }
    : null
}

export class PhoneSharedAgents {
  private readonly store = new PhoneSharedAgentStore()
  private readonly links = new Map<string, Link>()
  private readonly listeners = new Set<() => void>()
  private readonly held: PhoneSharedAgentHeld
  private readonly heldPoll = new PhoneSharedAgentHeldPoll({
    store: this.store,
    held: () => this.held
  })
  // Listed by a computer but with no key here yet (its host wasn't reached): shown, not callable.
  private readonly awaitingKey = new Map<string, readonly SharedBotPhoneShare[]>()
  private readonly follows = new PhoneSharedAgentFollows<UnvalidatedRpcRequestPort>(
    (pairedHostId, client, applied) => this.followComputer({ pairedHostId, client }, applied)
  )
  // Each computer's client its shares were last followed with, to follow them again.
  private readonly computers = new Map<string, UnvalidatedRpcRequestPort>()
  private readonly kept = new PhoneSharedAgentKeptReads()

  constructor(private readonly now: () => number = Date.now) {
    this.held = new PhoneSharedAgentHeld({
      store: this.store,
      now,
      changed: () => {
        this.changed()
        this.heldPoll.poll()
      }
    })
  }

  ready(): Promise<void> {
    return this.store.load()
  }

  /** Whether `find` already answers from what the device keeps. */
  loaded(): boolean {
    return this.store.hasLoaded()
  }

  /** Reads Orca Cloud's states for the agents with a message waiting, and again while one waits. */
  refreshHeld(entries?: readonly PhoneSharedAgent[]): Promise<void> {
    return this.heldPoll.refresh(entries)
  }

  onChanged(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Follows the computer's list: new shares get a key, gone ones are forgotten, the rest dial. */
  async syncComputer(pairedHostId: string, client: UnvalidatedRpcRequestPort): Promise<void> {
    this.computers.set(pairedHostId, client)
    await this.follows.run(pairedHostId, client)
  }

  /** Whether the computer still lists `entry` once its follow under way, if any, lands: a link that
   *  dropped may be a revoke, which ends the follow it started without the share. */
  private async stillShared(entry: PhoneSharedAgent): Promise<boolean> {
    await this.follows.nextListed(entry.pairedHostId)
    return this.store.get(entry.shareId) !== undefined
  }

  private async followComputer(computer: Computer, applied: () => void): Promise<void> {
    await this.ready()
    const { pairedHostId } = computer
    const shares = await readComputerShares(computer)
    if (shares) {
      const listed = new Set(shares.map((share) => share.shareId))
      for (const entry of this.store.list()) {
        if (entry.pairedHostId === pairedHostId && !listed.has(entry.shareId)) {
          this.forget(entry.shareId)
          this.kept.forget(entry.shareId)
        }
      }
    }
    // What a revoke check waits for: the list, not the keys and dials that follow.
    applied()
    if (shares) {
      await syncComputerShares(
        this.store,
        computer,
        shares,
        (entry) => phoneSharedAgentCredential(entry, this.now()) === null
      )
      this.awaitingKey.set(
        pairedHostId,
        shares.filter((share) => !this.store.get(share.shareId))
      )
    }
    await Promise.all(
      this.store
        .list()
        .filter((entry) => entry.pairedHostId === pairedHostId)
        .map(async (entry) => {
          await this.reach(entry)
          await this.refreshHeld([entry])
        })
    )
    this.changed()
  }

  /** What the computer's pages show of its shared agents, as the desktop window does. */
  views(pairedHostId: string): SharedBotHostView[] {
    return this.store
      .list()
      .filter((entry) => entry.pairedHostId === pairedHostId)
      .map((entry) => this.view(entry))
      .concat((this.awaitingKey.get(pairedHostId) ?? []).map(awaitingKeyView))
  }

  /** The shared agent the computer `pairedHostId` names `environmentId`, when this phone has a key. */
  find(pairedHostId: string, environmentId: string): PhoneSharedAgent | undefined {
    return this.store
      .list()
      .find((entry) => entry.pairedHostId === pairedHostId && entry.environmentId === environmentId)
  }

  async call(entry: PhoneSharedAgent, method: string, params: unknown): Promise<RpcResponse> {
    const link = await this.reach(entry)
    if (link !== 'live' && !(await this.stillShared(entry))) {
      return sharedAgentUnshared(method)
    }
    // Answered on the phone: a new chat's placeholder, or a send held (or refused) for the host.
    const here =
      this.held.startHere(this.view(entry).holds, link, method, params) ??
      (method === 'agentSession.send' ? await this.sendHeld(entry, link, params) : null)
    if (here) {
      return here
    }
    const away = () =>
      this.kept.answer(entry.shareId, method, params) ?? sharedAgentOffline(entry, method)
    if (link !== 'live') {
      return away()
    }
    try {
      const response = await this.linkFor(entry).request(method, params)
      this.held.noteAnswer(entry, method, params, response)
      this.kept.noteAnswer(entry.shareId, method, params, response)
      return response
    } catch {
      return away()
    }
  }

  subscribe(
    entry: PhoneSharedAgent,
    method: string,
    params: unknown,
    onData: (result: unknown) => void
  ): () => void {
    let stop: (() => void) | null = null
    let released = false
    void this.reach(entry).then(async (link) => {
      const shared = link === 'live' || (await this.stillShared(entry))
      if (released) {
        return
      }
      if (!shared) {
        onData({ type: 'error', message: SHARED_BOT_UNSHARED_MESSAGE })
        return
      }
      if (link !== 'live') {
        // While away, a chat shows what its host last streamed of it, if this launch saw it.
        stop = this.kept.replay(entry.shareId, method, params, onData)
        if (!stop) {
          onData({ type: 'error', message: sharedAgentOffline(entry, method).error.message })
        }
        return
      }
      const kept = this.kept.recording(entry.shareId, method, params, onData)
      stop = this.linkFor(entry).subscribe(method, params, kept)
    })
    return () => {
      released = true
      stop?.()
    }
  }

  /** The computer's shared agents as `views` reads them, now and on each change that alters them. */
  watch(pairedHostId: string, onViews: (views: SharedBotHostView[]) => void): () => void {
    let last: string | null = null
    const emit = () => {
      const views = this.views(pairedHostId)
      const seen = JSON.stringify(views)
      if (seen !== last) {
        last = seen
        onViews(views)
      }
    }
    let stopped = false
    const stop = this.onChanged(emit)
    void this.ready().then(() => !stopped && emit())
    return () => {
      stopped = true
      stop()
    }
  }

  async sendAgain(entry: PhoneSharedAgent, clientMessageId: string): Promise<boolean> {
    return await this.held.sendAgain(entry, clientMessageId)
  }

  /** A send that belongs on the held queue: held, or why not; null when it goes to the host live. */
  private async sendHeld(
    entry: PhoneSharedAgent,
    link: SharedHostLink,
    params: unknown
  ): Promise<RpcResponse | null> {
    const send = this.held.heldSend(params)
    if (!send || !this.held.sendsHeld(entry, link, send.chat)) {
      return send || link === 'live' ? null : sharedAgentOffline(entry, 'agentSession.send')
    }
    const result = await this.held.hold(entry, send)
    if (result === 'unshared') {
      this.forget(entry.shareId)
    }
    return heldSendFailure(entry, result)
  }

  /** The agent as its pages show it: whether it holds (the off switch applied there) and what. */
  private view(entry: PhoneSharedAgent): SharedBotHostView {
    return sharedBotHostView(entry, {
      homeWorkspaceId: null,
      link: this.linkFor(entry).current(),
      holds: true,
      held: this.held.views(entry)
    })
  }

  /** The link once any dial the phone can make with what it keeps has settled. */
  private async reach(entry: PhoneSharedAgent): Promise<SharedHostLink> {
    const link = this.linkFor(entry)
    const credential = phoneSharedAgentCredential(entry, this.now())
    return credential ? await link.connect(credential) : await link.settled()
  }

  private linkFor(entry: PhoneSharedAgent): Link {
    let link = this.links.get(entry.shareId)
    if (!link) {
      link = new SharedHostRelayLink<PhoneSharedAgent>({
        platform: MOBILE_RELAY_CLIENT_PLATFORM,
        clientCapabilities: MOBILE_RUNTIME_CLIENT_CAPABILITIES,
        entry: () => this.store.get(entry.shareId),
        save: (next) => this.store.put(next),
        onLinkChanged: (next, previous) => {
          const current = this.store.get(entry.shareId)
          const computer = this.computers.get(entry.pairedHostId)
          // The host dropped the live link (a revoke closes it): the computer's list says whether.
          if (previous === 'live' && next === 'offline' && computer) {
            void this.syncComputer(entry.pairedHostId, computer)
          }
          // The host refused this phone's key (revoked) and nothing kept can dial it: dropped until
          // the computer lists it again and the host gives a new key.
          if (
            next === 'unpaired' &&
            current &&
            phoneSharedAgentCredential(current, this.now()) === null
          ) {
            this.forget(entry.shareId)
            return
          }
          this.changed()
          // The host is back: its journal has what it took while away, so ask how they stand.
          if (next === 'live' && current) {
            void this.refreshHeld([current])
          }
        },
        sign: async (current, message) =>
          nacl.sign.detached(message, PRIMITIVES.decodeBase64(current.deviceKey.secretKeyB64)),
        randomBytes: (length) => PRIMITIVES.randomBytes(length),
        newId: randomV4Uuid
      })
      this.links.set(entry.shareId, link)
    }
    return link
  }

  private forget(shareId: string): void {
    this.store.remove(new Set([shareId]))
    this.links.get(shareId)?.close()
    this.links.delete(shareId)
    this.changed()
  }

  private changed(): void {
    this.listeners.forEach((listener) => listener())
  }
}

let instance: PhoneSharedAgents | null = null

/** The phone's one owner of its shared agents. */
export function phoneSharedAgents(): PhoneSharedAgents {
  instance ??= new PhoneSharedAgents()
  return instance
}

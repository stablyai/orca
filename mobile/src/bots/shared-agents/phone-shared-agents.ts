// The agents shared with the accounts of the computers this phone is paired to. The phone reaches each
// agent's host on its own, over Orca Relay with its own key, so they keep working while the computer is
// off; a message to a host that is away is held in Orca Cloud with the phone's share credential.
import nacl from 'tweetnacl'
import {
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
import { heldSendFailure, sharedAgentOffline } from './phone-shared-agent-failures'
import { PhoneSharedAgentFollows } from './phone-shared-agent-follows'
import { PhoneSharedAgentHeld } from './phone-shared-agent-held'
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

// While a message waits, Orca Cloud is asked how it stands this often (the desktop's busy read),
// backing off to at most HELD_POLL_MAX_MS while it doesn't answer.
const HELD_POLL_MS = 30_000
const HELD_POLL_MAX_MS = 5 * 60_000

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
  private heldTimer: ReturnType<typeof setTimeout> | null = null
  private heldReadFailures = 0
  // Listed by a computer but with no key here yet (its host wasn't reached): shown, not callable.
  private readonly awaitingKey = new Map<string, readonly SharedBotPhoneShare[]>()
  private readonly follows = new PhoneSharedAgentFollows<UnvalidatedRpcRequestPort>(
    (pairedHostId, client) => this.followComputer({ pairedHostId, client })
  )
  private readonly kept = new PhoneSharedAgentKeptReads()

  constructor(private readonly now: () => number = Date.now) {
    this.held = new PhoneSharedAgentHeld({
      store: this.store,
      now,
      changed: () => {
        this.changed()
        this.pollHeld()
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

  /**
   * Reads Orca Cloud's states for the agents with a message waiting, and again every HELD_POLL_MS
   * while one still waits: a delivered message lets that chat's later sends go live again.
   */
  async refreshHeld(entries = this.store.list()): Promise<void> {
    const answered = await Promise.all(
      entries
        .filter((entry) => entry.held.some((held) => this.held.isWaiting(held)))
        .map((entry) => this.held.refresh(entry))
    )
    this.heldReadFailures = answered.includes(false) ? this.heldReadFailures + 1 : 0
    this.pollHeld()
  }

  private pollHeld(): void {
    const waiting = this.store
      .list()
      .some((entry) => entry.held.some((held) => this.held.isWaiting(held)))
    if (!waiting) {
      clearTimeout(this.heldTimer ?? undefined)
      this.heldTimer = null
      return
    }
    if (this.heldTimer) {
      return
    }
    const delay = Math.min(HELD_POLL_MS * 2 ** this.heldReadFailures, HELD_POLL_MAX_MS)
    this.heldTimer = setTimeout(() => {
      this.heldTimer = null
      void this.refreshHeld()
    }, delay)
  }

  onChanged(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Follows the computer's list: new shares get a key, gone ones are forgotten, the rest dial. */
  async syncComputer(pairedHostId: string, client: UnvalidatedRpcRequestPort): Promise<void> {
    await this.follows.run(pairedHostId, client)
  }

  private async followComputer(computer: Computer): Promise<void> {
    await this.ready()
    const { pairedHostId } = computer
    const shares = await readComputerShares(computer)
    if (shares) {
      const listed = new Set(shares.map((share) => share.shareId))
      for (const entry of this.store.list()) {
        if (entry.pairedHostId === pairedHostId && !listed.has(entry.shareId)) {
          this.links.get(entry.shareId)?.close()
          this.links.delete(entry.shareId)
          this.kept.forget(entry.shareId)
        }
      }
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
      .map((entry) =>
        sharedBotHostView(entry, {
          homeWorkspaceId: null,
          link: this.linkFor(entry).current(),
          holds: true,
          held: this.held.views(entry)
        })
      )
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
    const here = this.held.startHere(link, method, params)
    if (here) {
      return here
    }
    if (method === 'agentSession.send') {
      const held = await this.sendHeld(entry, link, params)
      if (held) {
        return held
      }
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
    void this.reach(entry).then((link) => {
      if (released) {
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
        onLinkChanged: (next) => {
          const current = this.store.get(entry.shareId)
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

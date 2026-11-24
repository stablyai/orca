// The agents shared with the accounts of the computers this phone is paired to. The phone reaches each
// agent's host on its own, over Orca Relay with its own key, so they keep working while the computer is
// off; a message to a host that is away is held in Orca Cloud with the phone's share credential.
import nacl from 'tweetnacl'
import {
  SHARED_BOT_HOST_ERRORS,
  type SharedBotHostView
} from '../../../../src/shared/bots/shared-bot-hosts'
import type {
  RpcFailure,
  RpcResponse
} from '../../../../src/shared/remote-runtime/rpc/rpc-response-shape'
import type { SharedHostRelayCredential } from '../../../../src/shared/remote-runtime/relay/client/shared-host-relay-connection'
import {
  SharedHostRelayLink,
  type SharedHostLink
} from '../../../../src/shared/remote-runtime/relay/client/shared-host-relay-link'
import { MOBILE_PAIRED_E2EE_PRIMITIVES as PRIMITIVES } from '../../transport/encryption/mobile-paired-e2ee-primitives'
import { MOBILE_RELAY_CLIENT_PLATFORM } from '../../transport/encryption/mobile-relay-client-platform'
import type { UnvalidatedRpcRequestPort } from '../../transport/rpc/unvalidated-rpc-request-port'
import { randomV4Uuid } from '../../platform/random-v4-uuid'
import { PhoneSharedAgentHeld } from './phone-shared-agent-held'
import { readComputerShares, syncComputerShares } from './phone-shared-agent-provisioning'
import { PhoneSharedAgentStore, type PhoneSharedAgent } from './phone-shared-agent-store'

type Link = SharedHostRelayLink<PhoneSharedAgent>

// While a message waits, Orca Cloud is asked how it stands this often (the desktop's busy read).
const HELD_POLL_MS = 30_000

const failure = (method: string, code: string, message: string): RpcFailure => ({
  id: method,
  ok: false,
  error: { code, message }
})

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
    await Promise.all(
      entries
        .filter((entry) => entry.held.some((held) => this.held.isWaiting(held)))
        .map((entry) => this.held.refresh(entry))
    )
  }

  private pollHeld(): void {
    const waiting = this.store
      .list()
      .some((entry) => entry.held.some((held) => this.held.isWaiting(held)))
    if (!waiting || this.heldTimer) {
      return
    }
    this.heldTimer = setTimeout(() => {
      this.heldTimer = null
      void this.refreshHeld()
    }, HELD_POLL_MS)
  }

  onChanged(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Follows the computer's list: new shares get a key, gone ones are forgotten, the rest dial. */
  async syncComputer(pairedHostId: string, client: UnvalidatedRpcRequestPort): Promise<void> {
    await this.ready()
    const computer = { pairedHostId, client }
    const shares = await readComputerShares(computer)
    if (shares) {
      for (const entry of this.store.list()) {
        if (
          entry.pairedHostId === pairedHostId &&
          !shares.some((s) => s.shareId === entry.shareId)
        ) {
          this.links.get(entry.shareId)?.close()
          this.links.delete(entry.shareId)
        }
      }
      await syncComputerShares(
        this.store,
        computer,
        shares,
        (entry) => phoneSharedAgentCredential(entry, this.now()) === null
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
      .map((entry) => ({
        environmentId: entry.environmentId,
        shareId: entry.shareId,
        botId: entry.botId,
        botName: entry.botName,
        ownerName: entry.ownerName,
        homeWorkspaceId: null,
        link: this.linkFor(entry).current(),
        holds: true,
        held: this.held.views(entry)
      }))
  }

  /** The shared agent the computer `pairedHostId` names `environmentId`, when this phone has a key. */
  find(pairedHostId: string, environmentId: string): PhoneSharedAgent | undefined {
    return this.store
      .list()
      .find((entry) => entry.pairedHostId === pairedHostId && entry.environmentId === environmentId)
  }

  async call(entry: PhoneSharedAgent, method: string, params: unknown): Promise<RpcResponse> {
    const link = await this.reach(entry)
    if (method === 'agentSession.send') {
      const held = await this.sendHeld(entry, link, params)
      if (held) {
        return held
      }
    }
    if (link !== 'live') {
      return this.offline(entry, method)
    }
    try {
      return await this.linkFor(entry).request(method, params)
    } catch {
      return this.offline(entry, method)
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
        onData({ type: 'error', message: this.offline(entry, method).error.message })
        return
      }
      stop = this.linkFor(entry).subscribe(method, params, onData)
    })
    return () => {
      released = true
      stop?.()
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
      return send || link === 'live' ? null : this.offline(entry, 'agentSession.send')
    }
    const result = await this.held.hold(entry, send)
    const method = 'agentSession.send'
    if (result === 'held') {
      return failure(
        method,
        SHARED_BOT_HOST_ERRORS.held,
        `Waiting for ${entry.ownerName}’s computer`
      )
    }
    return result === 'too-large'
      ? failure(
          method,
          SHARED_BOT_HOST_ERRORS.tooLarge,
          `Too large to hold; send it when ${entry.ownerName}’s computer is online`
        )
      : this.offline(entry, method)
  }

  private offline(entry: PhoneSharedAgent, method: string): RpcFailure {
    return failure(
      method,
      SHARED_BOT_HOST_ERRORS.offline,
      `${entry.ownerName}’s computer is offline`
    )
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
        entry: () => this.store.get(entry.shareId),
        save: (next) => this.store.put(next),
        onLinkChanged: (next) => {
          this.changed()
          // The host is back: its journal has what it took while away, so ask how they stand.
          const current = this.store.get(entry.shareId)
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

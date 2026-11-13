import { EventEmitter } from 'node:events'
import type { AgentProviderKey } from './agent-provider-key'
import type {
  AgentIdentityWorkerRequest,
  AgentIdentityWorkerResponse
} from './agent-identity-worker-protocol'
import type { WorkerRequestTransport } from '../../worker-threads/worker-thread-transport'
import type { AgentIdentityClient, AgentIdentityLookup } from './agent-identity-worker-client'
import { handleAgentIdentityRequest } from './agent-identity-worker-entry'
import { isOrcaSessionId, type OrcaSessionId } from '../../../shared/orca-session-address'

/** The worker's real SQL handler behind an asynchronous boundary, counting requests. Each answer
 *  can be held so a test decides when (and in which order) replies arrive. */
export class InProcessAgentIdentityClient implements AgentIdentityClient {
  identifyRequests = 0
  hasRequests = 0
  providerKeyRequests = 0
  /** When set, `identify` waits for `release()` before answering. */
  hold = false
  /** Answers the next N identify requests as unavailable after running their SQL. */
  failAfterCommit = 0
  private held: (() => void)[] = []

  async identify(path: string, key: AgentProviderKey): Promise<AgentIdentityLookup> {
    this.identifyRequests++
    if (this.hold) {
      await new Promise<void>((resolve) => this.held.push(resolve))
    }
    const response = handleAgentIdentityRequest({ id: 0, kind: 'identify', path, key })
    if (!response.ok || this.failAfterCommit-- > 0) {
      return undefined
    }
    const value = response.value
    return value === null
      ? { id: null }
      : typeof value === 'string' && isOrcaSessionId(value)
        ? { id: value }
        : undefined
  }

  async has(path: string, orcaSessionId: string): Promise<boolean | undefined> {
    this.hasRequests++
    const response = handleAgentIdentityRequest({ id: 0, kind: 'has', path, orcaSessionId })
    return response.ok && typeof response.value === 'boolean' ? response.value : undefined
  }

  async providerKeyOf(
    path: string,
    orcaSessionId: string
  ): Promise<{ key: AgentProviderKey | null } | undefined> {
    this.providerKeyRequests++
    const response = handleAgentIdentityRequest({
      id: 0,
      kind: 'providerKeyOf',
      path,
      orcaSessionId
    })
    return response.ok && typeof response.value === 'object' && !Array.isArray(response.value)
      ? { key: response.value }
      : undefined
  }

  async idsOfProviderSession(
    path: string,
    providerSessionId: string
  ): Promise<OrcaSessionId[] | undefined> {
    const response = handleAgentIdentityRequest({
      id: 0,
      kind: 'idsOfProviderSession',
      path,
      providerSessionId
    })
    return response.ok && Array.isArray(response.value)
      ? response.value.filter(isOrcaSessionId)
      : undefined
  }

  /** Lets every held request answer, oldest first. */
  release(): void {
    for (const resolve of this.held.splice(0)) {
      resolve()
    }
  }

  readonly isRetiring = false

  retired(): Promise<void> {
    return Promise.resolve()
  }

  dispose(): void {}
}

type ScriptedAnswer = AgentIdentityWorkerResponse | 'never'

/** Fake identity worker threads behind the real client and request queue: each request is
 *  answered after `serviceMs` by `answer`, and exits can be held to prove no worker starts
 *  beside a retiring one. */
export class ScriptedIdentityWorkers {
  readonly posts: AgentIdentityWorkerRequest[] = []
  spawns = 0
  live = 0
  maxLive = 0
  serviceMs = 0
  spawnFails = false
  holdExit = false
  readonly known = new Set<string>()
  answer: (request: AgentIdentityWorkerRequest) => ScriptedAnswer = (request) =>
    request.kind === 'identify'
      ? { id: request.id, ok: true, value: `claude_${request.key.providerSessionId}` }
      : {
          id: request.id,
          ok: true,
          value: request.kind === 'has' && this.known.has(request.orcaSessionId)
        }
  private readonly exits: (() => void)[] = []

  readonly factory = (): WorkerRequestTransport => {
    if (this.spawnFails) {
      throw new Error('identity worker could not start')
    }
    this.spawns++
    this.live++
    this.maxLive = Math.max(this.maxLive, this.live)
    const worker = new EventEmitter()
    let exited = false
    const exit = (): void => {
      if (!exited) {
        exited = true
        this.live--
        worker.emit('exit', 1)
      }
    }
    return Object.assign(worker, {
      unref: () => {},
      postMessage: (request: AgentIdentityWorkerRequest) => {
        this.posts.push(request)
        const reply = this.answer(request)
        if (reply !== 'never') {
          setTimeout(() => !exited && worker.emit('message', reply), this.serviceMs)
        }
      },
      terminate: () =>
        new Promise<number>((resolve) => {
          const done = (): void => {
            exit()
            resolve(1)
          }
          if (this.holdExit) {
            this.exits.push(done)
          } else {
            queueMicrotask(done)
          }
        })
    })
  }

  identifyPosts(): number {
    return this.posts.filter((post) => post.kind === 'identify').length
  }

  releaseExits(): void {
    for (const exit of this.exits.splice(0)) {
      exit()
    }
  }
}

import type { ConnectorAdapter } from './connector-adapter.js'
import type { ClaimedPost, ConnectorPosts } from './connector-posts.js'

// How one send went, as the source's adapter judged it.
export type SendOutcome =
  | { kind: 'posted'; messageRef?: string }
  // Already sent before a lost reply.
  | { kind: 'found'; messageRef: string }
  | { kind: 'retry'; afterMs?: number }
  | { kind: 'failed' }
  // It may have posted and that couldn't be checked, so it is never sent again.
  | { kind: 'uncertain' }
  // It may or may not have reached the source: left sending, so the lease brings it back to the
  // adapter's check for a sent copy.
  | { kind: 'unknown' }

// Sends one source's queued posts through its adapter.
export class PostWorker {
  constructor(
    private readonly posts: ConnectorPosts,
    private readonly adapter: Pick<ConnectorAdapter, 'send'>
  ) {}

  // Claimed heads are in different containers and go out in parallel, well inside their lease. A
  // database error leaves its post sending, so the lease brings it back to the sent-copy check.
  async sendDue(): Promise<void> {
    const claimed = await this.posts.claim()
    const sent = await Promise.allSettled(
      claimed.map(async (post) => await this.finish(post, await this.adapter.send(post)))
    )
    const failure = sent.find((result) => result.status === 'rejected')
    if (failure) {
      throw failure.reason
    }
  }

  private async finish(post: ClaimedPost, outcome: SendOutcome): Promise<void> {
    const { posts } = this
    switch (outcome.kind) {
      case 'posted':
        await posts.posted(post, outcome.messageRef)
        break
      case 'found':
        await posts.found(post, outcome.messageRef)
        break
      case 'retry':
        await posts.retry(post, outcome.afterMs)
        break
      case 'failed':
        await posts.settle(post, 'failed')
        break
      case 'uncertain':
        if (await posts.settle(post, 'uncertain')) {
          console.warn(
            JSON.stringify({ event: 'orca_connector_post_uncertain', source: posts.source })
          )
        }
        break
      case 'unknown':
        break
    }
  }
}

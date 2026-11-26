import type { ConnectorFailure, ConnectorResult } from './connector-cloud-request'
import type { ConnectorTransport } from './connector-machine'
import {
  botPostPresentationFor,
  foldConnectorReview,
  postConnectorBotMessage,
  postConnectorReply,
  replyPresentationFor,
  type ConnectorBotPostBody,
  type ConnectorReplyBody
} from './connector-replies'

export class ConnectorPostRequests {
  private posting = 0

  constructor(
    private readonly deps: {
      transport: () => ConnectorTransport
      signal: AbortSignal
      random: () => number
      features: () => ReadonlySet<string> | null
      helloRev: () => number | null
      refresh: (helloRev: number | null) => Promise<ConnectorFailure | null>
    }
  ) {}

  get idle(): boolean {
    return this.posting === 0
  }

  readonly reply = (body: ConnectorReplyBody, proceed?: () => boolean) => {
    const send = () => {
      const features = this.deps.features()
      const eligible = replyPresentationFor(body, features)
      const sent = features?.has('review') ? eligible : foldConnectorReview(eligible)
      return postConnectorReply(
        this.deps.transport(),
        sent,
        this.deps.signal,
        this.deps.random,
        proceed
      )
    }
    return this.posted(body.presentation ? this.presented(send, proceed) : send())
  }

  readonly postAsBot = (botId: string, body: ConnectorBotPostBody) => {
    const send = () =>
      postConnectorBotMessage(
        this.deps.transport(),
        botId,
        botPostPresentationFor(body, this.deps.features()),
        this.deps.signal,
        this.deps.random
      )
    return this.posted('presentation' in body && body.presentation ? this.presented(send) : send())
  }

  private posted<T>(post: Promise<T>): Promise<T> {
    this.posting++
    return post.finally(() => this.posting--)
  }

  private async presented<T>(
    send: () => Promise<ConnectorResult<T>>,
    proceed?: () => boolean
  ): Promise<ConnectorResult<T>> {
    const helloRev = this.deps.helloRev()
    const sent = await send()
    if (
      sent.ok ||
      this.deps.signal.aborted ||
      !(
        sent.error === 'hello_required' ||
        (sent.status === 400 && (sent.error === 'invalid_request' || sent.error === 'invalid_v'))
      )
    ) {
      return sent
    }
    const refused = await this.deps.refresh(helloRev)
    if (refused || this.deps.signal.aborted || proceed?.() === false) {
      return refused ?? sent
    }
    return await send()
  }
}

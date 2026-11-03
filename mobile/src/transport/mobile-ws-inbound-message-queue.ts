import {
  WsInboundMessageBudget,
  WsInboundMessageQueue
} from '../../../src/shared/ws-inbound-message-queue'

// Keep stalled conversions charged when their physical connection is retired or replaced.
const budget = new WsInboundMessageBudget()

export class MobileWsInboundMessageQueue extends WsInboundMessageQueue {
  constructor(
    processMessage: ConstructorParameters<typeof WsInboundMessageQueue>[0],
    onError: ConstructorParameters<typeof WsInboundMessageQueue>[1]
  ) {
    super(processMessage, onError, budget)
  }
}

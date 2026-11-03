import type {
  BridgePortObservation,
  BridgeQueuedObservation
} from '../../mobile-web-shell/bridge/bridge-port-pair-test-harness'
import { captureArguments, captureError } from './recording-values'

import type { RecordingCausality } from './recording-causality'
import type {
  Message,
  Reply,
  BridgePostObservation,
  BridgeReceiptObservation
} from './recording-causality-contract'
import { wire } from './recording-port-message'

export function openCausalBridge(owner: RecordingCausality): BridgePortObservation {
  owner.bridge = true
  const pair = ++owner.pairs
  const document = 1
  let posts = 0
  const messages = new Map<string, Message[]>()
  const neutral = (receive: () => void) => owner.parent.run({ kind: 'other' }, receive)
  const delivery = (message: Message): BridgeQueuedObservation => {
    const observed: BridgeQueuedObservation = {
      enqueued: () =>
        owner.fault.capture('port enqueue', () => {
          message.observation.enqueued = owner.ordinal()
        }),
      runDelivery: (receive) => {
        owner.fault.capture('port delivery', () =>
          message.observation.deliveries.push(owner.ordinal())
        )
        return owner.parent.run(message, receive)
      }
    }
    return observed
  }
  return {
    invokePage: (args, invoke) => {
      try {
        const parent = owner.parent.getStore()
        if (owner.closed || parent?.kind !== 'attempt' || !parent.bridge || !parent.originalArgs) {
          throw new Error('Page invocation has no actual live attempt')
        }
        if (
          parent.observation.bridge?.page ||
          args.length !== parent.originalArgs.length ||
          args.some((value, index) => value !== parent.originalArgs![index])
        ) {
          throw new Error('Wrapper changed or added a page invocation')
        }
        parent.observation.bridge!.page = {
          pair,
          document
        }
      } catch (error) {
        owner.fault.report('actual page invocation', error)
      }
      const held = owner.parent.getStore()
      const page = held?.kind === 'attempt' ? held.observation.bridge?.page : undefined
      try {
        const result = invoke()
        try {
          if (page) {
            page.afterArgs = captureArguments(args)
            page.didThrow = false
          }
        } catch (error) {
          owner.fault.report('actual page ordinary return', error)
        }
        return result
      } catch (error) {
        try {
          if (page) {
            page.afterArgs = captureArguments(args)
            page.didThrow = true
            page.error = captureError(error)
          }
        } catch (observationError) {
          owner.fault.report('actual page synchronous throw', observationError)
        }
        throw error
      }
    },
    capturePost: (json, direction): BridgeQueuedObservation =>
      owner.fault.capture('port post', () => {
        if (owner.closed) {
          throw new Error('Post after recording closed')
        }
        const value = wire(json)
        if (direction === 'shell' && value.type === 'request' && typeof value.method === 'string') {
          const parent = owner.parent.getStore()
          if (!parent || parent.kind !== 'attempt' || typeof value.id !== 'string') {
            throw new Error('Unary post has no actual attempt or page ID')
          }
          if (parent.method !== value.method || parent.observation.bridge?.posts.length) {
            throw new Error('Unary post changed method or duplicated its attempt')
          }
          if (
            parent.observation.bridge?.page?.pair !== pair ||
            parent.observation.bridge.page.document !== document
          ) {
            throw new Error('Actual post came from a different page invocation')
          }
          const observation: BridgePostObservation = {
            parent: parent.observation.name,
            pair,
            document,
            post: ++posts,
            id: value.id,
            json,
            ordinal: owner.ordinal(),
            deliveries: [],
            replies: [],
            children: []
          }
          const message: Message = { kind: 'message', attempt: parent, observation }
          parent.observation.bridge!.posts.push(observation)
          messages.set(value.id, [...(messages.get(value.id) ?? []), message])
          const observed = delivery(message)
          observed.captureReceipt = (receipt) =>
            owner.fault.capture('fixture receipt', () => {
              let value: unknown
              try {
                value = JSON.parse(receipt)
              } catch {
                value = null
              }
              const id =
                value && typeof value === 'object' && 'id' in value && typeof value.id === 'string'
                  ? value.id
                  : undefined
              const injected: BridgeReceiptObservation = {
                parent: observation.parent,
                pair,
                document,
                post: ++posts,
                ...(id === undefined ? {} : { id }),
                json: receipt,
                ordinal: owner.ordinal(),
                deliveries: [],
                replies: [],
                children: []
              }
              ;(observation.receipts ??= []).push(injected)
              const newcomer: Message = {
                kind: 'message',
                attempt: parent,
                observation: injected
              }
              if (id !== undefined) {
                messages.set(id, [...(messages.get(id) ?? []), newcomer])
              }
              return delivery(newcomer)
            })
          return observed
        }
        if (
          direction === 'page' &&
          (value.type === 'reply' || value.type === 'error') &&
          typeof value.id === 'string'
        ) {
          const current = owner.parent.getStore()
          const candidates = messages.get(value.id) ?? []
          const message =
            current?.kind === 'message' && current.observation.id === value.id
              ? current
              : candidates.length === 1
                ? candidates[0]
                : undefined
          if (message) {
            const entry: BridgePostObservation['replies'][number] = {
              json,
              ordinal: owner.ordinal()
            }
            message.observation.replies.push(entry)
            const reply: Reply = { kind: 'reply', message, entry }
            const observed: BridgeQueuedObservation = {
              enqueued: () => {},
              runDelivery: (receive) => owner.parent.run(reply, receive)
            }
            return observed
          }
          if (candidates.length) {
            throw new Error('Ambiguous bridge reply parent')
          }
        }
        return { enqueued: () => {}, runDelivery: neutral }
      }),
    receivePage: (original, delivered) =>
      owner.fault.capture('page receipt', () => {
        const delivery = owner.parent.getStore()
        if (delivery?.kind === 'reply') {
          if (delivery.entry.json !== original || delivery.entry.deliveryOrdinal !== undefined) {
            throw new Error('Wrong or duplicate reply receipt')
          }
          delivery.entry.delivered = delivered
          delivery.entry.deliveryOrdinal = owner.ordinal()
        }
      })
  }
}

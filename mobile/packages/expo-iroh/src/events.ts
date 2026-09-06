import ExpoIrohModule from './ExpoIrohModule'
import type {
  ExpoIrohEventMap,
  IrohClosedEvent,
  IrohMessageEvent,
  IrohPathChangedEvent
} from './types'

export type MessageCallback = (event: IrohMessageEvent) => void
export type PathChangedCallback = (event: IrohPathChangedEvent) => void
export type ClosedCallback = (event: IrohClosedEvent) => void

export function addIrohListener<K extends keyof ExpoIrohEventMap>(
  eventName: K,
  handler: (event: ExpoIrohEventMap[K]) => void
) {
  return ExpoIrohModule.addListener(eventName, handler)
}

export function onIrohMessage(handler: MessageCallback) {
  return addIrohListener('onMessage', handler)
}

export function onIrohPathChanged(handler: PathChangedCallback) {
  return addIrohListener('onPathChanged', handler)
}

export function onIrohClosed(handler: ClosedCallback) {
  return addIrohListener('onClosed', handler)
}

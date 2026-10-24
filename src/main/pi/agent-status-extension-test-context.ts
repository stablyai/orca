import { EventEmitter } from 'node:events'
import type { HookHandler } from './agent-status-extension-test-harness'
import { getPiTitlebarExtensionSource } from './titlebar-extension-source'

export function createCountingMap(onEntry?: () => void) {
  return class<K, V> extends Map<K, V> {
    *values(): MapIterator<V> {
      for (const value of super.values()) {
        onEntry?.()
        yield value
      }
    }
    *[Symbol.iterator](): MapIterator<[K, V]> {
      for (const entry of super[Symbol.iterator]()) {
        onEntry?.()
        yield entry
      }
    }
  }
}

export function createSessionProducers<T>(
  args: { kind: 'pi' | 'omp' | 'prime-agent'; titlebar?: 'first' | 'last' | 'only' },
  evaluate: (source?: string) => (api: T) => void
) {
  const titleSource = args.titlebar ? getPiTitlebarExtensionSource(args.kind) : undefined
  let title = titleSource ? evaluate(titleSource) : undefined
  return {
    reload: () => {
      if (titleSource) {
        title = evaluate(titleSource)
      }
    },
    register: (status: (api: T) => void, api: T) => {
      const factories =
        args.titlebar === 'only'
          ? [title]
          : args.titlebar === 'first'
            ? [title, status]
            : [status, title]
      for (const factory of factories) {
        factory?.(api)
      }
    }
  }
}

export function addOrderedSessionHandler(
  target: Record<string, HookHandler>,
  name: string,
  handler: HookHandler
): void {
  const previous = target[name]
  target[name] = async (event, ctx) => {
    if (previous) {
      await previous(event, ctx)
    }
    await handler(event, ctx)
  }
}

export function createIndependentSession(
  register: (handlers: Record<string, HookHandler>, bus: EventEmitter) => void
) {
  const handlers: Record<string, HookHandler> = {}
  const bus = new EventEmitter()
  register(handlers, bus)
  return {
    callHook: (name: string, event?: unknown, ctx?: Parameters<HookHandler>[1]) =>
      Promise.resolve(handlers[name]?.(event, ctx)),
    emit: (name: string, event: unknown) => bus.emit(name, event)
  }
}

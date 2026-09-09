import { RuntimeLinearBrowseCommands } from './runtime-linear-browse-commands'
import { RuntimeLinearCommandBase } from './runtime-linear-command-base'
import { RuntimeLinearCommands } from './runtime-linear-connection-commands'

type PublicMethods<T> = Pick<T, keyof T>

export type RuntimeLinearCommandSurface = PublicMethods<RuntimeLinearCommands>

type LinearFacadeInstance = {
  linearCommands: RuntimeLinearCommands
}

type LinearMethodBag = Record<string, (...values: unknown[]) => unknown>

const delegators = new WeakSet<object>()
const receiverByCommands = new WeakMap<object, object>()

function collectMethodNames(instancePrototype: object, stopAt: object | null): Set<string> {
  const names = new Set<string>()
  let prototype: object | null = instancePrototype
  while (prototype && prototype !== Object.prototype && prototype !== stopAt) {
    for (const name of Object.getOwnPropertyNames(prototype)) {
      if (name !== 'constructor') {
        names.add(name)
      }
    }
    prototype = Object.getPrototypeOf(prototype)
  }
  return names
}

// Why: the chain used to live on the facade, so a facade override (test spy) has to win for re-entrant `this` calls too.
function overrideAwareReceiver(
  facade: object,
  commands: object,
  surfaceNames: ReadonlySet<string>
): object {
  const cached = receiverByCommands.get(commands)
  if (cached) {
    return cached
  }
  const receiver = new Proxy(commands, {
    get(target, property, proxyReceiver) {
      if (typeof property === 'string' && surfaceNames.has(property)) {
        const override = (facade as Record<string, unknown>)[property]
        if (typeof override === 'function' && !delegators.has(override)) {
          return override.bind(facade)
        }
      }
      return Reflect.get(target, property, proxyReceiver)
    }
  })
  receiverByCommands.set(commands, receiver)
  return receiver
}

export function installRuntimeLinearCommandSurface(target: object): void {
  const names = collectMethodNames(
    RuntimeLinearCommands.prototype,
    RuntimeLinearCommandBase.prototype
  )
  for (const name of collectMethodNames(RuntimeLinearBrowseCommands.prototype, null)) {
    names.add(name)
  }
  for (const name of names) {
    const method = {
      [name](this: LinearFacadeInstance, ...args: unknown[]): unknown {
        const commands = this.linearCommands as unknown as LinearMethodBag
        return Reflect.apply(commands[name], overrideAwareReceiver(this, commands, names), args)
      }
    }[name]
    delegators.add(method)
    Object.defineProperty(target, name, {
      configurable: true,
      enumerable: false,
      writable: true,
      value: method
    })
  }
}

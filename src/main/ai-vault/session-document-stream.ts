import { StringDecoder } from 'node:string_decoder'
import { FlexAssembler, arrayRule, objectRule } from 'stream-json/core/utils/flex-assembler.js'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import { createJsonTokenReader } from '../../shared/json-token-reader'
import { throwIfAiVaultScanCancelled } from './ai-vault-scan-cancellation'

/** Fold one root array while retaining only the root fields the agent parser uses. */
export async function readStreamedSessionDocument<T>(args: {
  bytes: AsyncIterable<Buffer>
  arrayKey: string
  fields: readonly string[]
  objectFields?: Readonly<Record<string, readonly string[]>>
  create: () => T
  consume: (state: T, value: unknown) => void
  signal?: AbortSignal
}): Promise<{ record: Record<string, unknown>; state: T } | null> {
  const record: Record<string, unknown> = Object.create(null)
  const fields = new Set(args.fields)
  const objectFields = new Map(
    Object.entries(args.objectFields ?? {}).map(([root, keys]) => [root, new Set(keys)])
  )
  const foldedArray = Symbol('folded session array')
  let state = args.create()
  let consumeFailure: { error: unknown } | undefined
  let inFoldedArray = false
  const reset = (): void => {
    state = args.create()
    consumeFailure = undefined
  }
  const retain = (path: (string | number)[]): boolean => {
    const [root, child] = path
    return (
      typeof root === 'string' &&
      ((root !== args.arrayKey && fields.has(root)) ||
        (inFoldedArray && root === args.arrayKey && path.length >= 2) ||
        (typeof child === 'string' && objectFields.get(root)?.has(child) === true))
    )
  }
  // Every discarded container needs a rule; dropping only its parent still builds large children.
  const discard = {
    filter: (path: (string | number)[]) => !retain(path),
    create: () => null,
    add: () => {}
  }
  const assembler = new FlexAssembler({
    maxDepth: Infinity,
    objectRules: [
      objectRule<Record<string, unknown>>({
        filter: (path) => path.length === 0,
        create: () => record,
        add: (target, key, value) => {
          if (key === args.arrayKey) {
            if (value !== foldedArray) {
              reset()
            }
          } else if (fields.has(key)) {
            target[key] = value
          }
        }
      }),
      objectRule<Record<string, unknown>>({
        filter: (path) =>
          path.length === 1 &&
          typeof path[0] === 'string' &&
          objectFields.has(path[0]) &&
          (!fields.has(path[0]) || path[0] === args.arrayKey),
        create: (path) => {
          const projected: Record<string, unknown> = Object.create(null)
          record[String(path[0])] = projected
          return projected
        },
        add: (target, key, value) => {
          const root = assembler.path[0]
          if (typeof root === 'string' && objectFields.get(root)?.has(key)) {
            target[key] = value
          }
        }
      }),
      discard
    ],
    arrayRules: [
      arrayRule<null>({
        filter: (path) => Boolean(args.arrayKey) && path.length === 1 && path[0] === args.arrayKey,
        create: () => {
          reset()
          inFoldedArray = true
          return null
        },
        add: (_target, value) => {
          if (!consumeFailure) {
            try {
              args.consume(state, value)
            } catch (error) {
              consumeFailure = { error }
            }
          }
        },
        finalize: () => {
          inFoldedArray = false
          return foldedArray
        }
      }),
      discard
    ]
  })
  const parser = createJsonTokenReader((token) => {
    if (
      token.name === 'keyValue' &&
      assembler.depth === 1 &&
      !assembler.isArray &&
      objectFields.has(token.value)
    ) {
      record[token.value] = Object.create(null)
    }
    assembler.consume(token)
  })
  const decoder = new StringDecoder('utf8')
  let objectRoot: boolean | undefined
  for await (const chunk of args.bytes) {
    throwIfAiVaultScanCancelled(args.signal)
    if (objectRoot === undefined) {
      const first = chunk.find((byte) => byte !== 32 && byte !== 9 && byte !== 10 && byte !== 13)
      if (first !== undefined) {
        objectRoot = first === 123
      }
    }
    parser.write(decoder.write(chunk))
    await yieldToEventLoop()
  }
  const tail = decoder.end()
  if (tail) {
    parser.write(tail)
  }
  parser.end()
  throwIfAiVaultScanCancelled(args.signal)
  if (consumeFailure) {
    throw consumeFailure.error
  }
  return objectRoot ? { record, state } : null
}

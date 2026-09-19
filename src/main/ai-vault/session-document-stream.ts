import { StringDecoder } from 'node:string_decoder'
import { JSONParser, TokenizerError, TokenParserError, TokenType } from '@streamparser/json'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
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
  const parser = new JSONParser({
    paths: [
      ...args.fields.map((field) => `$.${field}`),
      ...Object.entries(args.objectFields ?? {}).flatMap(([root, fields]) =>
        fields.map((field) => `$.${root}.${field}`)
      ),
      ...(args.arrayKey ? [`$.${args.arrayKey}`, `$.${args.arrayKey}.*`] : [])
    ],
    keepStack: false,
    stringBufferSize: 64 * 1024
  })
  const record: Record<string, unknown> = Object.create(null)
  const fields = new Set(args.fields)
  let depth = 0
  let expectingRootKey = false
  parser.onToken = ({ token, value }) => {
    if (depth === 1 && expectingRootKey && token === TokenType.STRING) {
      if (typeof value === 'string' && Object.hasOwn(args.objectFields ?? {}, value)) {
        record[value] = Object.create(null)
      }
      expectingRootKey = false
    }
    if (token === TokenType.LEFT_BRACE || token === TokenType.LEFT_BRACKET) {
      if (depth === 0 && token === TokenType.LEFT_BRACE) {
        expectingRootKey = true
      }
      depth++
    } else if (token === TokenType.RIGHT_BRACE || token === TokenType.RIGHT_BRACKET) {
      depth--
    } else if (token === TokenType.COMMA && depth === 1) {
      expectingRootKey = true
    }
  }
  let state = args.create()
  let currentArray: unknown = null
  let consumeFailure: { error: unknown } | undefined
  const decoder = new StringDecoder('utf8')
  let objectRoot: boolean | undefined
  parser.onValue = ({ key, value, parent, stack }) => {
    if (stack.length === 2 && stack[1].key === args.arrayKey && Array.isArray(parent)) {
      if (parent !== currentArray) {
        state = args.create()
        consumeFailure = undefined
        currentArray = parent
      }
      if (!consumeFailure) {
        try {
          args.consume(state, value)
        } catch (error) {
          consumeFailure = { error }
        }
      }
      // The parser's array cursor is independent of retained array slots.
      parent.pop()
    } else if (
      stack.length === 2 &&
      typeof stack[1].key === 'string' &&
      typeof key === 'string' &&
      parent &&
      !Array.isArray(parent)
    ) {
      const root = stack[1].key
      const projected = record[root]
      if (
        Object.hasOwn(args.objectFields ?? {}, root) &&
        args.objectFields?.[root]?.includes(key) &&
        projected &&
        typeof projected === 'object'
      ) {
        Reflect.set(projected, key, value)
      }
    } else if (stack.length === 1 && typeof key === 'string') {
      if (key === args.arrayKey) {
        if (value !== currentArray || !Array.isArray(value)) {
          state = args.create()
          consumeFailure = undefined
        }
        currentArray = null
      } else if (fields.has(key)) {
        record[key] = value
      }
      if (parent && typeof parent === 'object') {
        Reflect.deleteProperty(parent, key)
      }
    }
  }
  for await (const chunk of args.bytes) {
    throwIfAiVaultScanCancelled(args.signal)
    if (objectRoot === undefined) {
      const first = chunk.find((byte) => byte !== 32 && byte !== 9 && byte !== 10 && byte !== 13)
      if (first !== undefined) {
        objectRoot = first === 123
      }
    }
    parseJson(() => parser.write(decoder.write(chunk)))
    await yieldToEventLoop()
  }
  const tail = decoder.end()
  if (tail) {
    parseJson(() => parser.write(tail))
  }
  if (objectRoot === undefined) {
    throw new SyntaxError('Unexpected end of JSON input')
  }
  if (!parser.isEnded) {
    parseJson(() => parser.end(), true)
  }
  throwIfAiVaultScanCancelled(args.signal)
  if (consumeFailure) {
    throw consumeFailure.error
  }
  return objectRoot ? { record, state } : null
}

function parseJson(run: () => void, ending = false): void {
  try {
    run()
  } catch (error) {
    if (
      error instanceof TokenizerError ||
      error instanceof TokenParserError ||
      (ending && error instanceof Error)
    ) {
      throw new SyntaxError(error.message)
    }
    throw error
  }
}

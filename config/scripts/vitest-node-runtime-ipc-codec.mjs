import { parse, stringify } from 'devalue'

// Why: devalue rejects Error objects, and a test file that fails to load reaches the IPC channel as one.
const reducers = {
  Error: (value) =>
    value instanceof Error && {
      name: value.name,
      message: value.message,
      stack: value.stack,
      cause: value.cause
    }
}

const revivers = {
  Error: ({ name, message, stack, cause }) => {
    const error = new Error(message, cause === undefined ? undefined : { cause })
    error.name = name
    error.stack = stack
    return error
  }
}

// Preserves RegExp filters, cyclic test results, and Errors across Bun/Node's JSON-only IPC boundary.
export function encodeNodeRuntimeMessage(value) {
  return stringify(value, reducers)
}

export function decodeNodeRuntimeMessage(text) {
  return parse(text, revivers)
}

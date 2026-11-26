type Fields = { [key: string]: Projection }
type Projection = true | Fields | [Projection]

const fields: Fields = {
  uuid: true,
  parentUuid: true,
  type: true,
  subtype: true,
  isSidechain: true,
  isMeta: true,
  isCompactSummary: true,
  teamName: true,
  agentId: true,
  sourceToolAssistantUUID: true,
  sessionId: true,
  cwd: true,
  commandRun: { command: true },
  attachment: { type: true, commandMode: true, origin: { kind: true } },
  message: { id: true, content: [{ type: true, id: true, tool_use_id: true }] },
  compactMetadata: {
    preservedMessages: { anchorUuid: true, uuids: [true] },
    preservedSegment: { anchorUuid: true, headUuid: true, tailUuid: true }
  }
}

const invalid = Symbol('invalid JSON')

/** Project only link fields from the raw row. Large strings in other fields stay as bytes. */
export function readClaudeImportLinks(bytes: Buffer): Record<string, unknown> | null {
  let position = 0
  let stack: Uint8Array | undefined
  try {
    space()
    if (bytes[position] !== 123) {
      return null
    }
    const row = object(fields)
    space()
    return position === bytes.length ? row : null
  } catch (error) {
    if (error === invalid || error instanceof SyntaxError) {
      return null
    }
    throw error
  }

  function space(): void {
    while (bytes[position] === 32 || bytes[position] === 9 || bytes[position] === 13) {
      position++
    }
  }

  function string(retain: boolean): string | undefined {
    const start = position++
    let escaped = false
    while (position < bytes.length) {
      const byte = bytes[position++]
      if (byte === 34) {
        if (retain) {
          return escaped
            ? JSON.parse(bytes.toString('utf8', start, position))
            : bytes.toString('utf8', start + 1, position - 1)
        }
        return
      }
      if (byte < 32) {
        throw invalid
      }
      if (byte === 92) {
        escaped = true
        const escape = bytes[position++]
        if (escape === 117) {
          for (let digit = 0; digit < 4; digit++) {
            const hex = bytes[position++]
            if (!(hex >= 48 && hex <= 57) && !((hex | 32) >= 97 && (hex | 32) <= 102)) {
              throw invalid
            }
          }
        } else if (
          escape !== 34 &&
          escape !== 92 &&
          escape !== 47 &&
          escape !== 98 &&
          escape !== 102 &&
          escape !== 110 &&
          escape !== 114 &&
          escape !== 116
        ) {
          throw invalid
        }
      }
    }
    throw invalid
  }

  function take(expected: number): boolean {
    space()
    if (bytes[position] !== expected) {
      return false
    }
    position++
    return true
  }

  function expect(expected: number): void {
    if (!take(expected)) {
      throw invalid
    }
  }

  function object(schema: Fields): Record<string, unknown> {
    position++
    const result: Record<string, unknown> = {}
    if (!take(125)) {
      do {
        space()
        if (bytes[position] !== 34) {
          throw invalid
        }
        const start = position
        string(false)
        // Field names are short, including their fully escaped form.
        const key = position - start <= 158 ? bytes.toString('utf8', start + 1, position - 1) : ''
        const name = key.includes('\\') ? JSON.parse(bytes.toString('utf8', start, position)) : key
        expect(58)
        if (Object.hasOwn(schema, name)) {
          result[name] = value(schema[name])
        } else {
          skip()
        }
      } while (take(44))
      expect(125)
    }
    return result
  }

  function value(schema: Projection): unknown {
    space()
    const byte = bytes[position]
    if (schema === true) {
      if (byte === 34) {
        return string(true)
      }
      if (byte === 116 || byte === 102 || byte === 110) {
        skip()
        return byte === 110 ? null : byte === 116
      }
    } else if (Array.isArray(schema)) {
      if (byte === 91) {
        position++
        const values: unknown[] = []
        if (!take(93)) {
          do {
            const member = value(schema[0])
            if (
              schema[0] === true ||
              (member &&
                typeof member === 'object' &&
                'type' in member &&
                (member.type === 'tool_use' || member.type === 'tool_result'))
            ) {
              values.push(member)
            }
          } while (take(44))
          expect(93)
        }
        return values
      }
    } else if (byte === 123) {
      return object(schema)
    }
    skip()
    // Preserve field presence without projecting an unneeded scalar or container.
    return byte === 110 ? null : 0
  }

  function digit(byte: number): boolean {
    return byte >= 48 && byte <= 57
  }

  function number(): void {
    if (bytes[position] === 45) {
      position++
    }
    if (!digit(bytes[position])) {
      throw invalid
    }
    if (bytes[position++] !== 48) {
      while (digit(bytes[position])) {
        position++
      }
    }
    if (bytes[position] === 46) {
      position++
      if (!digit(bytes[position])) {
        throw invalid
      }
      while (digit(bytes[position])) {
        position++
      }
    }
    if ((bytes[position] | 32) === 101) {
      position++
      if (bytes[position] === 43 || bytes[position] === 45) {
        position++
      }
      if (!digit(bytes[position])) {
        throw invalid
      }
      while (digit(bytes[position])) {
        position++
      }
    }
  }

  function skip(): void {
    let depth = 0
    do {
      space()
      const byte = bytes[position]
      if (byte === 34) {
        string(false)
      } else if (byte === 123 || byte === 91) {
        position++
        const close = byte === 123 ? 125 : 93
        if (!take(close)) {
          if (!stack || stack.length === depth) {
            const grown: Uint8Array = new Uint8Array(stack ? stack.length * 2 : 32)
            if (stack) {
              grown.set(stack)
            }
            stack = grown
          }
          stack[depth++] = close
          member(close)
          continue
        }
      } else if (byte === 116 || byte === 102 || byte === 110) {
        const literal = byte === 116 ? 'true' : byte === 102 ? 'false' : 'null'
        for (let index = 0; index < literal.length; index++) {
          if (bytes[position++] !== literal.charCodeAt(index)) {
            throw invalid
          }
        }
      } else {
        number()
      }
      while (depth > 0) {
        const close = stack![depth - 1]
        if (take(44)) {
          member(close)
          break
        }
        expect(close)
        depth--
      }
    } while (depth > 0)
  }

  function member(close: number): void {
    if (close === 125) {
      space()
      if (bytes[position] !== 34) {
        throw invalid
      }
      string(false)
      expect(58)
    }
  }
}

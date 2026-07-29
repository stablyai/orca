function jsonStringUtf8Bytes(value: string): number {
  let bytes = 2
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    if (codeUnit === 0x22 || codeUnit === 0x5c || codeUnit === 0x08 || codeUnit === 0x09) {
      bytes += 2
    } else if (codeUnit === 0x0a || codeUnit === 0x0c || codeUnit === 0x0d) {
      bytes += 2
    } else if (codeUnit < 0x20) {
      bytes += 6
    } else if (codeUnit < 0x80) {
      bytes += 1
    } else if (codeUnit < 0x800) {
      bytes += 2
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        index += 1
      } else {
        bytes += 6
      }
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      bytes += 6
    } else {
      bytes += 3
    }
  }
  return bytes
}

export function jsonUtf8ByteLength(value: unknown): number {
  const activeObjects = new Set<object>()

  const measure = (current: unknown, arrayElement: boolean): number | null => {
    if (current === null) {
      return 4
    }
    switch (typeof current) {
      case 'string':
        return jsonStringUtf8Bytes(current)
      case 'boolean':
        return current ? 4 : 5
      case 'number':
        return Number.isFinite(current) ? JSON.stringify(current).length : 4
      case 'undefined':
      case 'function':
      case 'symbol':
        return arrayElement ? 4 : null
      case 'bigint':
        throw new TypeError('Do not know how to serialize a BigInt')
      case 'object':
        break
    }

    const object = current as object
    if (activeObjects.has(object)) {
      throw new TypeError('Converting circular structure to JSON')
    }
    activeObjects.add(object)
    try {
      if (Array.isArray(object)) {
        let bytes = 2
        for (let index = 0; index < object.length; index += 1) {
          if (index > 0) {
            bytes += 1
          }
          bytes += measure(object[index], true) ?? 4
        }
        return bytes
      }

      let bytes = 2
      let entries = 0
      for (const key of Object.keys(object)) {
        const propertyBytes = measure((object as Record<string, unknown>)[key], false)
        if (propertyBytes === null) {
          continue
        }
        bytes += (entries > 0 ? 1 : 0) + jsonStringUtf8Bytes(key) + 1 + propertyBytes
        entries += 1
      }
      return bytes
    } finally {
      activeObjects.delete(object)
    }
  }

  const bytes = measure(value, false)
  if (bytes === null) {
    throw new TypeError('Value is not JSON serializable')
  }
  return bytes
}

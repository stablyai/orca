/** Generated extensions run on the agent host without access to Orca modules. */
export function getAgentStatusInputRedactionSourceLines(): string[] {
  return String.raw`
function statusInputReferencesCredentialPath(value: string): boolean {
  const path = value.replace(/\\/g, '/')
  return /(?:^|[^a-z0-9_.-]|\$(?:[a-z_][a-z0-9_]*|[0-9]))\.(?:ssh|ssh-mcp)(?=$|[^a-z0-9_.-])/i.test(path) ||
    /\.mcp-secrets\.env(?=$|[^a-z0-9_.-])/i.test(path) ||
    /(?:^|[^a-z0-9_.-]|\$(?:[a-z_][a-z0-9_]*|[0-9]))\.omp-backups-archive\/omp-bak-keyfile(?=$|[^a-z0-9_.-])/i.test(path)
}

function sanitizeStatusToolInput(input: unknown): unknown {
  const ancestors = new WeakSet<object>()
  let remainingNodes = 4096
  let remainingChars = 262144
  function checkText(text: string): void {
    remainingChars -= text.length
    if (remainingChars < 0 || statusInputReferencesCredentialPath(text)) throw new Error('redact')
  }
  function copy(value: unknown, depth: number): unknown {
    if (--remainingNodes < 0 || depth > 64) throw new Error('redact')
    if (typeof value === 'string') { checkText(value); return value }
    if (value === null || value === undefined || typeof value === 'boolean') return value
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value !== 'object' || ancestors.has(value)) throw new Error('redact')
    const array = Array.isArray(value)
    if (array) {
      const length = Object.getOwnPropertyDescriptor(value, 'length')?.value
      if (!Number.isSafeInteger(length) || length < 0 || length > remainingNodes) throw new Error('redact')
      remainingNodes -= length
    }
    const prototype = Object.getPrototypeOf(value)
    if (!array && prototype !== null) {
      const constructor = Object.getOwnPropertyDescriptor(prototype, 'constructor')
      if (Object.getPrototypeOf(prototype) !== null || !constructor || !('value' in constructor) ||
          typeof constructor.value !== 'function' ||
          Object.getOwnPropertyDescriptor(constructor.value, 'name')?.value !== 'Object') {
        throw new Error('redact')
      }
    }
    ancestors.add(value)
    // Copy data descriptors only; never return an object that can run toJSON later.
    const result = array ? [] : Object.create(null)
    if (array) Object.setPrototypeOf(result, null)
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') throw new Error('redact')
      checkText(key)
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !('value' in descriptor)) throw new Error('redact')
      const copied = copy(descriptor.value, depth + 1)
      Object.defineProperty(result, key, { value: copied, enumerable: descriptor.enumerable,
        writable: true, configurable: key !== 'length' || !array })
    }
    ancestors.delete(value)
    return result
  }
  try { return copy(input, 0) } catch { return { redacted: true } }
}
`
    .trim()
    .split('\n')
}

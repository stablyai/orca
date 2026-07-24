export async function responseBodyIncludesWithinLimit(response, needle, maxBytes) {
  const declaredLength = response.headers.get('content-length')
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > maxBytes) {
    await response.body?.cancel().catch(() => undefined)
    return false
  }
  if (!response.body) {
    return false
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let observedBytes = 0
  let suffix = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        return `${suffix}${decoder.decode()}`.includes(needle)
      }
      observedBytes += value.byteLength
      if (observedBytes > maxBytes) {
        await reader.cancel().catch(() => undefined)
        return false
      }
      const candidate = suffix + decoder.decode(value, { stream: true })
      if (candidate.includes(needle)) {
        await reader.cancel().catch(() => undefined)
        return true
      }
      suffix = candidate.slice(-Math.max(0, needle.length - 1))
    }
  } finally {
    reader.releaseLock()
  }
}

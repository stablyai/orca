import { createHash } from 'node:crypto'

const HEADER = /^\{"usageIntegrity":"([a-f0-9]{64})",/

export function sealUsageCacheJson(material: string, domain: string): string {
  if (!material.startsWith('{') || material === '{}') {
    throw new Error('Usage cache integrity requires a JSON object.')
  }
  const digest = createHash('sha256').update(domain).update('\n').update(material).digest('hex')
  return `{"usageIntegrity":"${digest}",${material.slice(1)}`
}

export function verifyUsageCacheJson(text: string, digest: unknown, domain: string): boolean {
  const header = HEADER.exec(text)
  if (!header) {
    if (digest !== undefined) {
      throw new Error('Saved usage cache integrity framing is invalid.')
    }
    return false
  }
  const expected = createHash('sha256')
    .update(domain)
    .update('\n{')
    .update(text.slice(header[0].length))
    .digest('hex')
  if (digest !== header[1] || expected !== header[1]) {
    throw new Error('Saved usage cache integrity does not match its contents.')
  }
  return true
}

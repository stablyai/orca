import http from 'node:http'
import type * as NodeDns from 'node:dns'
import type { LookupAddress } from 'node:dns'
import { describe, expect, it, vi } from 'vitest'
import { guardedLookup } from './link-preview-address-guard'

const RESOLVED: Record<string, LookupAddress[]> = {
  'rebind.test': [
    { address: '93.184.215.14', family: 4 },
    { address: '10.0.0.5', family: 4 }
  ],
  'mapped.test': [{ address: '::ffff:169.254.169.254', family: 6 }]
}

vi.mock('node:dns', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeDns>()
  return {
    ...actual,
    lookup: (
      hostname: string,
      _options: unknown,
      callback: (error: Error | null, addresses: LookupAddress[]) => void
    ) => callback(null, RESOLVED[hostname] ?? [])
  }
})

describe('guardedLookup', () => {
  it.each(['rebind.test', 'mapped.test'])(
    'refuses the connection when %s resolves to an internal address',
    async (host) => {
      const error = await new Promise<NodeJS.ErrnoException>((resolve) => {
        http
          .get({ host, port: 80, agent: false, lookup: guardedLookup }, () => {})
          .on('error', resolve)
      })
      expect(error.code).toBe('ERR_LINK_PREVIEW_BLOCKED_ADDRESS')
    }
  )
})

import http from 'node:http'
import type * as NodeDns from 'node:dns'
import type { LookupAddress } from 'node:dns'
import { describe, expect, it, vi } from 'vitest'
import { guardedLookup, linkPreviewTarget } from './link-preview-address-guard'

const RESOLVED: Record<string, LookupAddress[]> = {
  'public.test': [{ address: '93.184.215.14', family: 4 }],
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

describe('linkPreviewTarget', () => {
  it.each([
    'http://localhost:5173/',
    'http://LOCALHOST./',
    'http://app.localhost/',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://printer.local/',
    'http://0.0.0.0/',
    'http://127.0.0.1:8080/',
    'http://2130706433/',
    'http://10.1.2.3/',
    'http://172.31.255.1/',
    'http://192.168.1.10/',
    'http://100.64.0.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://198.18.0.1/',
    'http://224.0.0.1/',
    'http://255.255.255.255/',
    'http://[::]/',
    'http://[::1]/',
    'http://[FE80::1]/',
    'http://[fd12:3456::1]/',
    'http://[ff02::1]/',
    'http://[::ffff:10.0.0.1]/',
    'http://[::ffff:7f00:1]/',
    'http://[::127.0.0.1]/',
    'http://[64:ff9b::a9fe:a9fe]/',
    'http://user:secret@example.com/',
    'ftp://example.com/',
    'file:///etc/passwd',
    'javascript:alert(1)'
  ])('refuses %s', (url) => {
    expect(linkPreviewTarget(url)).toBeNull()
  })

  it.each([
    'https://example.com/a?b#c',
    'HTTP://GitHub.com:8443/x',
    'http://93.184.215.14/',
    'http://172.32.0.1/',
    'http://[2606:4700:4700::1111]/',
    'http://[::ffff:8.8.8.8]/',
    'http://[64:ff9b::808:808]/'
  ])('allows %s', (url) => {
    expect(linkPreviewTarget(url)).not.toBeNull()
  })
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

  it('hands Node every address when all resolve to public hosts', async () => {
    const addresses = await new Promise((resolve, reject) =>
      guardedLookup('public.test', { all: true }, (error, result) =>
        error ? reject(error) : resolve(result)
      )
    )
    expect(addresses).toEqual(RESOLVED['public.test'])
  })
})

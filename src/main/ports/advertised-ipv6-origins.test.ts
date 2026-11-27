import { expect, it } from 'vitest'
import { AdvertisedUrlWatcher } from './advertised-url-watcher'
import { extractUrlCandidates } from './advertised-url-parsing'

it('retains bracketed IPv6 advertised origins on default ports', () => {
  const watcher = new AdvertisedUrlWatcher({ now: () => 1000 })
  watcher.bindPty('server', 'workspace')
  watcher.ingest('server', 'Ready at (http://[::1]).\nSecure at https://[::1]\n')

  expect(watcher.lookup('workspace', 80)?.origin).toBe('http://[::1]')
  expect(watcher.lookup('workspace', 443)?.origin).toBe('https://[::1]')

  watcher.ingest('server', 'Explicit port: http://[::1]:3000.\nIPv4: http://127.0.0.1:4000)\n')
  expect(watcher.lookup('workspace', 3000)?.origin).toBe('http://[::1]:3000')
  expect(watcher.lookup('workspace', 4000)?.origin).toBe('http://127.0.0.1:4000')

  expect(
    extractUrlCandidates('Links: [http://localhost/path] [http://[::1]/?q=value]').map((url) =>
      url.toString()
    )
  ).toEqual(['http://localhost/path', 'http://[::1]/?q=value'])
})

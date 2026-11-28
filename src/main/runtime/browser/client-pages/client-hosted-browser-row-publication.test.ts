// A page shows on the host's window only from a computer known now to be the owner's: never a
// teammate's, and not while pairing is still loading or after the computer is revoked.
import { expect, it } from 'vitest'
import type { ClientHostedBrowserRowsEvent } from '../../../../shared/browser/client-hosting/client-hosted-browser-rows'
import { ClientHostedBrowserRowPublisher } from './client-hosted-browser-row-publication'
import { RuntimeBrowserPageRegistry } from './runtime-browser-page-registry'

const page = (browserPageId: string, pairedDeviceId: string) => ({
  browserPageId,
  workspaceId: 'wt-home',
  browserProfileId: 'default',
  executionHostKey: 'native',
  placement: {
    kind: 'client' as const,
    browserHostClientId: `${pairedDeviceId}-host`,
    browserHostGeneration: 1,
    pageHostGeneration: 1
  },
  pairedDeviceId,
  url: 'https://example.com',
  loading: false,
  active: false
})

function setUp() {
  const pages = new RuntimeBrowserPageRegistry()
  pages.publishClientPage(page('owners-laptop-page', 'owners-laptop'))
  pages.publishClientPage(page('teammate-page', 'teammate-desk'))
  // Null until pairing loads; then the owner's paired computers (a teammate's is never among them).
  const owners: { devices: Set<string> | null } = { devices: null }
  const emitted: ClientHostedBrowserRowsEvent[] = []
  const rows = new ClientHostedBrowserRowPublisher({
    listClientPages: (worktreeId) => pages.pagesOf('host', worktreeId),
    getClientPage: (browserPageId) => pages.getPage(browserPageId),
    hasLivePlacement: () => true,
    resolveDeviceName: (pairedDeviceId) => pairedDeviceId,
    isOwnerDevice: (pairedDeviceId) => owners.devices?.has(pairedDeviceId) ?? false,
    getEmitter: () => (event) => emitted.push(event)
  })
  const lastShown = () => emitted.at(-1)?.rows.map((row) => row.browserPageId)
  return { rows, owners, emitted, lastShown }
}

it('hydrates nothing before pairing loads, then shows only the owner’s computer’s page', () => {
  const { rows, owners, lastShown } = setUp()
  expect(rows.deliverHydrationSnapshot()).toEqual([])

  owners.devices = new Set(['owners-laptop'])
  rows.publishAll()
  expect(lastShown()).toEqual(['owners-laptop-page'])
  // A client that shows it as a placeholder still learns whose computer it is on.
  expect(rows.row('teammate-page')).toMatchObject({ hostDeviceName: 'teammate-desk' })
  expect(
    rows.deliverHydrationSnapshot().flatMap((event) => event.rows.map((row) => row.browserPageId))
  ).toEqual(['owners-laptop-page'])
})

it('retracts a computer’s page once it is no longer known as the owner’s', () => {
  const { rows, owners, lastShown } = setUp()
  owners.devices = new Set(['owners-laptop'])
  rows.publish('wt-home')
  expect(lastShown()).toEqual(['owners-laptop-page'])

  owners.devices = new Set()
  rows.publishAll()
  expect(lastShown()).toEqual([])
})

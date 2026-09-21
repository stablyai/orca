import { describe, expect, it } from 'vitest'
import { projectClientHostedBrowserRows } from './client-hosted-browser-row-projection'
import { RuntimeBrowserPageRegistry } from './runtime-browser-page-registry'

function registryWithPages(): RuntimeBrowserPageRegistry {
  const registry = new RuntimeBrowserPageRegistry()
  registry.publishClientPage({
    browserPageId: 'page-live',
    workspaceId: 'wt-1',
    browserProfileId: 'default',
    executionHostKey: 'native:runtime-a:7',
    placement: {
      kind: 'client',
      browserHostClientId: 'host-a',
      browserHostGeneration: 3,
      pageHostGeneration: 9
    },
    pairedDeviceId: 'device-a',
    url: 'https://live.test/docs',
    title: 'Live docs',
    loading: false,
    active: true
  })
  registry.publishClientPage({
    browserPageId: 'page-retained',
    workspaceId: 'wt-1',
    browserProfileId: 'default',
    executionHostKey: 'native:runtime-a:7',
    placement: {
      kind: 'client',
      browserHostClientId: 'host-b',
      browserHostGeneration: 1,
      pageHostGeneration: 1
    },
    pairedDeviceId: 'device-b',
    url: 'https://retained.test/',
    title: 'Retained',
    loading: true,
    active: false
  })
  return registry
}

describe('projectClientHostedBrowserRows', () => {
  it('projects the display fields the host strip renders', () => {
    const rows = projectClientHostedBrowserRows(registryWithPages().listPages('wt-1'), {
      hasLivePlacement: () => true,
      resolveDeviceName: (pairedDeviceId) =>
        pairedDeviceId === 'device-a' ? "Jinwoo's MacBook" : null
    })

    expect(rows).toEqual([
      {
        browserPageId: 'page-live',
        worktreeId: 'wt-1',
        url: 'https://live.test/docs',
        title: 'Live docs',
        loading: false,
        browserHostClientId: 'host-a',
        hostDeviceName: "Jinwoo's MacBook",
        hostAbsent: false
      },
      {
        browserPageId: 'page-retained',
        worktreeId: 'wt-1',
        url: 'https://retained.test/',
        title: 'Retained',
        loading: true,
        browserHostClientId: 'host-b',
        hostDeviceName: null,
        hostAbsent: false
      }
    ])
  })

  it('marks a page whose host is gone as absent', () => {
    const rows = projectClientHostedBrowserRows(registryWithPages().listPages('wt-1'), {
      hasLivePlacement: (browserPageId) => browserPageId !== 'page-retained',
      resolveDeviceName: () => null
    })

    expect(rows.map((row) => [row.browserPageId, row.hostAbsent])).toEqual([
      ['page-live', false],
      ['page-retained', true]
    ])
  })

  // Why: nothing is driving an absent host's page, so a spinner on that row would never stop.
  it('settles the loading flag on an absent host', () => {
    const rows = projectClientHostedBrowserRows(registryWithPages().listPages('wt-1'), {
      hasLivePlacement: () => false,
      resolveDeviceName: () => null
    })

    expect(rows.map((row) => [row.browserPageId, row.loading])).toEqual([
      ['page-live', false],
      ['page-retained', false]
    ])
  })

  it('keeps the device name of a retained page whose lease is already gone', () => {
    const rows = projectClientHostedBrowserRows(registryWithPages().listPages('wt-1'), {
      hasLivePlacement: () => false,
      resolveDeviceName: (pairedDeviceId) => (pairedDeviceId === 'device-b' ? 'Studio' : null)
    })

    expect(rows[1]).toMatchObject({ hostDeviceName: 'Studio', hostAbsent: true })
  })

  it('reports no device name for a page created before the record carried one', () => {
    const registry = new RuntimeBrowserPageRegistry()
    registry.publishClientPage({
      browserPageId: 'page-anonymous',
      workspaceId: 'wt-1',
      browserProfileId: 'default',
      executionHostKey: 'native:runtime-a:7',
      placement: {
        kind: 'client',
        browserHostClientId: 'host-a',
        browserHostGeneration: 1,
        pageHostGeneration: 1
      },
      url: 'https://anonymous.test/',
      loading: false,
      active: false
    })
    const resolved: (string | undefined)[] = []

    const rows = projectClientHostedBrowserRows(registry.listPages('wt-1'), {
      hasLivePlacement: () => true,
      resolveDeviceName: (pairedDeviceId) => {
        resolved.push(pairedDeviceId)
        return 'should not be asked for'
      }
    })

    expect(resolved).toEqual([])
    expect(rows[0].hostDeviceName).toBeNull()
  })
})

import { describe, expect, it } from 'vitest'

import { countHostCollectionJsxMaps, isScannedPath } from './check-host-list-render-ratchet.mjs'

describe('countHostCollectionJsxMaps', () => {
  it('counts JSX drawn straight from a host collection', () => {
    expect(
      countHostCollectionJsxMaps(
        '{hostOptions.map((host) => (\n  <SelectItem key={host.id} value={host.id} />\n))}'
      )
    ).toBe(1)
    expect(
      countHostCollectionJsxMaps('{props.sshConnections.map((c) => <Row key={c.id} />)}')
    ).toBe(1)
    expect(countHostCollectionJsxMaps('{targets.map(t => <li key={t.id} />)}')).toBe(1)
  })

  it('ignores bounded rows, data maps and comments', () => {
    expect(countHostCollectionJsxMaps('{rows.shown.map((host) => <Row key={host.id} />)}')).toBe(0)
    expect(countHostCollectionJsxMaps('{targetRows.shown.map((t) => <Row key={t.id} />)}')).toBe(0)
    expect(countHostCollectionJsxMaps('new Map(hostOptions.map((host) => [host.id, host]))')).toBe(
      0
    )
    expect(countHostCollectionJsxMaps('hosts.map((host) => ({ id: host.id }))')).toBe(0)
    expect(countHostCollectionJsxMaps('// hosts.map((h) => <Row />)')).toBe(0)
  })
})

describe('isScannedPath', () => {
  it('scans renderer components outside the host-picker primitive', () => {
    expect(isScannedPath('src/renderer/src/components/settings/A.tsx')).toBe(true)
    expect(isScannedPath('src/renderer/src/components/host-picker/HostCombobox.tsx')).toBe(false)
    expect(isScannedPath('src/renderer/src/components/settings/A.test.tsx')).toBe(false)
    expect(isScannedPath('src/renderer/src/components/settings/a.ts')).toBe(false)
    expect(isScannedPath('src/main/a.tsx')).toBe(false)
  })
})

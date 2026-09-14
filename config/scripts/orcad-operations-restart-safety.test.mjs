import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const operationsGuide = readFileSync('docs/reference/orcad-operations.md', 'utf8')
const operationsProse = operationsGuide.replace(/\s+/g, ' ')

describe('orcad operations restart safety', () => {
  it('distinguishes PID-scoped preservation from systemd cgroup teardown', () => {
    expect(operationsProse).toContain(
      'This makes a PID-scoped update, rollback or restart non-destructive to live work'
    )
    expect(operationsProse).toContain(
      'The successor adopts the current endpoint and routes supported previous protocol versions through legacy adapters'
    )
    expect(operationsProse).toContain('`KillMode=mixed` does **not** preserve them')
    expect(operationsProse).toContain(
      '`KillMode=process` leaves service-owned processes unmanaged and is not a supported preservation mechanism'
    )
  })

  it('fails closed before cgroup-wide maintenance', () => {
    expect(operationsProse).toContain(
      'A safe empty census is untruncated, has an explicit `hostScope`, covers every execution host affected by the stop, and lists no terminals on those hosts'
    )
    expect(operationsProse).toContain(
      "Every `omittedHostIds` entry must be explicitly accounted for outside the target service's execution boundary"
    )
    expect(operationsProse).toContain(
      '`sudo -Hu orca /home/orca/.local/bin/orca-ide terminal list --json`'
    )
    expect(operationsGuide).not.toContain('sudo -Hu orca orca-ide terminal list --json')
    expect(operationsProse).toContain(
      'A separately paired runtime is outside that boundary; local execution and SSH hosts reached through this runtime are not. An affected or unknown omission, missing scope, truncation, a failed request or lost contact makes the result `unverifiable`'
    )
    expect(operationsProse).toContain('Orca does not yet provide an atomic census-and-stop fence')
  })

  it('does not refer to the unavailable shipping design', () => {
    expect(operationsGuide).not.toContain('docs/design/shipping-orcad.html')
  })
})

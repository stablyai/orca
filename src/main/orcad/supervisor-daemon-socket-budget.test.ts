import { describe, expect, it } from 'vitest'
import { auditDaemonSocketPathBudget } from './supervisor-daemon-socket-budget'
import { renderSupervisorService } from '../../shared/supervisor-service-render'
import type { SupervisorServiceFile } from '../../shared/supervisor-service-file-read'

const LONG_ROOT = `/home/${'x'.repeat(120)}/.orca`

function unitPinning(userDataPath: string): SupervisorServiceFile {
  return {
    path: '/etc/systemd/system/orcad.service',
    platform: 'systemd',
    scope: 'system',
    text: renderSupervisorService({
      platform: 'systemd',
      scope: 'system',
      nodePath: '/usr/local/bin/node',
      orcadPath: '/opt/orcad/orcad.js',
      userDataPath,
      user: 'orca',
      bind: '127.0.0.1',
      port: 6800
    })
  }
}

describe('daemon socket path budget finding', () => {
  it('passes an ordinary root', () => {
    const finding = auditDaemonSocketPathBudget(unitPinning('/home/orca/.orca'), '/home/orca/.orca')
    expect(finding.severity).toBe('ok')
    expect(finding.code).toBe('daemon_socket_path_fits')
  })

  it('is critical when the definition itself pins a root that cannot host the socket', () => {
    const finding = auditDaemonSocketPathBudget(unitPinning(LONG_ROOT), '/home/orca/.orca')
    expect(finding.severity).toBe('critical')
    expect(finding.message).toMatch(/not survive a restart/)
    expect(finding.remedy).toMatch(/ORCA_USER_DATA/)
  })

  it('measures what the file pins, not what this shell resolves', () => {
    // The doctor usually runs from a different account than the service. Reading the caller's
    // root would answer for the wrong host and pass a service that cannot work.
    expect(auditDaemonSocketPathBudget(unitPinning(LONG_ROOT), '/home/orca/.orca').severity).toBe(
      'critical'
    )
    expect(auditDaemonSocketPathBudget(unitPinning('/home/orca/.orca'), LONG_ROOT).severity).toBe(
      'ok'
    )
  })

  it('warns, and says whose root it measured, when no definition pins one', () => {
    const finding = auditDaemonSocketPathBudget(undefined, LONG_ROOT)
    // Not critical: `critical` claims a configuration will destroy terminals, and only a file
    // that pins a root can say that about the installed service.
    expect(finding.severity).toBe('warning')
    expect(finding.message).toContain('this shell resolves')
  })
})

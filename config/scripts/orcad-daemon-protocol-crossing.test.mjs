// D7: orcad's update and rollback planning must agree with the CI protocol-crossing facts.
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DAEMON_PROTOCOL_SOURCE_PATH,
  canAttach,
  parseDaemonProtocolFacts
} from './daemon-protocol-facts.mjs'
import { CURRENT_ORCAD_DAEMON_PROTOCOL } from '../../src/main/ssh/orcad-daemon-protocol-crossing'
import { assessOrcadRollback, planOrcadUpdate } from '../../src/main/ssh/orcad-update-plan'

const projectDir = resolve(import.meta.dirname, '../..')
const current = parseDaemonProtocolFacts(
  readFileSync(join(projectDir, DAEMON_PROTOCOL_SOURCE_PATH), 'utf8')
)
// The release before the newest protocol bump: it speaks one version lower and cannot list ours.
const older = {
  protocolVersion: current.protocolVersion - 1,
  previousProtocolVersions: current.previousProtocolVersions.filter(
    (version) => version < current.protocolVersion - 1
  )
}
const record = {
  schemaVersion: 1,
  active: '0.3.0+new',
  previous: '0.2.0+old',
  activatedAt: '2026-01-01T00:00:00.000Z',
  snapshot: {
    dirName: 'pre-0.3.0+new-1',
    takenBeforeVersion: '0.3.0+new',
    readableByVersion: '0.2.0+old',
    takenAt: '2026-01-01T00:00:00.000Z'
  }
}
const live = (daemonProtocolVersion) => ({
  liveSessions: 2,
  startedSinceActivation: 0,
  daemonProtocolVersion
})

function rollback(target, daemonProtocolVersion) {
  return assessOrcadRollback({
    record,
    snapshotPresent: true,
    census: live(daemonProtocolVersion),
    targetDaemonProtocol: target,
    stateWritesSinceActivation: false
  })
}

describe('orcad daemon protocol crossing', () => {
  it('deploys exactly the protocol the working tree declares', () => {
    expect({
      protocolVersion: CURRENT_ORCAD_DAEMON_PROTOCOL.protocolVersion,
      previousProtocolVersions: [...CURRENT_ORCAD_DAEMON_PROTOCOL.previousProtocolVersions]
    }).toEqual(current)
  })

  it('keeps terminals on rollback only when the old build lists the new protocol', () => {
    expect(canAttach(older, current)).toBe(false)
    expect(rollback(older, current.protocolVersion)).toMatchObject({
      safety: 'unsafe',
      code: 'orcad_rollback_strands_live_terminals'
    })
    // A daemon preserved from before the activation still speaks the old build's protocol.
    expect(canAttach(older, older)).toBe(true)
    expect(rollback(older, older.protocolVersion)).toMatchObject({ safety: 'clean' })
    const listing = { ...older, previousProtocolVersions: [...older.previousProtocolVersions] }
    listing.previousProtocolVersions.push(current.protocolVersion + 1)
    expect(canAttach(listing, { ...current, protocolVersion: current.protocolVersion + 1 })).toBe(
      true
    )
    expect(rollback(listing, current.protocolVersion + 1)).toMatchObject({ safety: 'clean' })
  })

  it('updates over live terminals only when the candidate can attach their daemon', () => {
    const plan = (daemonProtocolVersion) =>
      planOrcadUpdate({
        record,
        candidateVersion: '0.4.0+next',
        census: live(daemonProtocolVersion),
        candidateDaemonProtocol: current,
        force: true
      })
    expect(canAttach(current, older)).toBe(true)
    expect(plan(older.protocolVersion)).toMatchObject({
      action: 'proceed',
      preservesLiveDaemon: true
    })
    const dropped = current.protocolVersion + 1
    expect(canAttach(current, { protocolVersion: dropped, previousProtocolVersions: [] })).toBe(
      false
    )
    expect(plan(dropped)).toMatchObject({
      action: 'defer',
      code: 'orcad_update_strands_live_terminals'
    })
  })
})

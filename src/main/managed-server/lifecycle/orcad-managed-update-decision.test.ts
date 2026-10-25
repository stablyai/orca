import { describe, expect, it } from 'vitest'
import { emptyOrcadActivationRecord } from '../activation/orcad-activation-record'
import {
  admitOrcadRecordForIntent,
  planOrcadUpdateForIntent
} from './orcad-managed-update-decision'

const rolledBack = {
  ...emptyOrcadActivationRecord(),
  active: '1.4.0+aa',
  activeAppVersion: '1.4.0',
  rolledBackFrom: '1.5.0+ab'
}
const newer = { ...emptyOrcadActivationRecord(), active: '2.0.0+cd', activeAppVersion: '2.0.0' }
const input = { candidateVersion: '1.5.0+ab', appVersion: '1.5.0', failedBefore: true }

describe('the three update intents', () => {
  it('skips a build this host refused on a connect only', () => {
    expect(planOrcadUpdateForIntent('connect', { ...input, record: rolledBack })).toEqual({
      action: 'skip',
      reason: 'rolled-back'
    })
    expect(planOrcadUpdateForIntent('update', { ...input, record: rolledBack })).toEqual({
      action: 'update'
    })
    expect(planOrcadUpdateForIntent('force', { ...input, record: rolledBack })).toEqual({
      action: 'update'
    })
  })

  it('keeps a newer host on Update, and lifts it only on Force', () => {
    expect(planOrcadUpdateForIntent('update', { ...input, record: newer })).toEqual({
      action: 'skip',
      reason: 'host-newer'
    })
    expect(admitOrcadRecordForIntent('update', '1.5.0')(newer, '1.5.0+ab')).toMatch(
      /Orca 2\.0\.0 last ran/
    )
    expect(admitOrcadRecordForIntent('force', '1.5.0')(newer, '1.5.0+ab')).toBeNull()
    expect(admitOrcadRecordForIntent('update', '1.5.0')(rolledBack, '1.5.0+ab')).toBeNull()
  })
})

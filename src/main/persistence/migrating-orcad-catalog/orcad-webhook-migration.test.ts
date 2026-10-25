import { describe, expect, it } from 'vitest'
import {
  DORMANT_AUTOMATION,
  DORMANT_AUTOMATION_RUN
} from './persistence-orcad-migration-catalog-fixture'
import {
  parseOrcadMigrationDormantAutomations,
  parseOrcadMigrationDormantAutomationRuns
} from '../../../shared/orcad-migration/orcad-migration-dormant-automation-validation'

describe('dormant webhook migration', () => {
  it('refuses a live webhook even when its schedule is paused', () => {
    expect(() =>
      parseOrcadMigrationDormantAutomations([
        {
          ...DORMANT_AUTOMATION,
          webhook: { enabled: true, secretMode: 'token', secret: 'test-secret' }
        }
      ])
    ).toThrow('orcad_migration_dormant_automation_webhook_invalid')
  })

  it('retains the configuration of a disabled webhook', () => {
    const automation = {
      ...DORMANT_AUTOMATION,
      webhook: { enabled: false, secretMode: 'token', secret: 'test-secret' }
    }
    expect(parseOrcadMigrationDormantAutomations([automation])).toEqual([automation])
  })

  it('retains a completed webhook run and its captured body', () => {
    const run = {
      ...DORMANT_AUTOMATION_RUN,
      trigger: 'webhook',
      webhookDelivery: { body: 'event', contentType: 'text/plain', receivedAt: 1, truncated: false }
    }
    expect(parseOrcadMigrationDormantAutomationRuns([run])).toEqual([run])
  })
})

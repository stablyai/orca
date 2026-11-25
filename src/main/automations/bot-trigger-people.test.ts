import { describe, expect, it } from 'vitest'
import type { AutomationEventTrigger } from '../../shared/automation-event-triggers'
import { assertCloudTakesTriggers, CI_FINISHED_TRIGGERS_UNSUPPORTED } from './bot-trigger-people'

const ALL = { own: true, github2: true, workflows: true, ciFinished: true }

describe('assertCloudTakesTriggers: github.ci_finished', () => {
  const subject = 'stablyai/orca#482'
  const ciFinished: AutomationEventTrigger = {
    id: 'r1',
    source: 'github',
    event: 'ci_finished',
    subject
  }
  const ciPassed: AutomationEventTrigger = {
    id: 'r2',
    source: 'github',
    event: 'ci_passed',
    subject
  }

  it('takes a new rule only from an Orca Cloud that sends it, and keeps one already saved', () => {
    expect(() => assertCloudTakesTriggers(ALL, [ciFinished])).not.toThrow()
    expect(() => assertCloudTakesTriggers({ ...ALL, ciFinished: false }, [ciFinished])).toThrow(
      CI_FINISHED_TRIGGERS_UNSUPPORTED
    )
    expect(() =>
      assertCloudTakesTriggers({ ...ALL, ciFinished: false }, [ciFinished], [ciFinished])
    ).not.toThrow()
    expect(() => assertCloudTakesTriggers({ ...ALL, ciFinished: false }, [ciPassed])).not.toThrow()
  })
})

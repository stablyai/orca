import { describe, expect, it } from 'vitest'
import { parseAutomationEventTrigger } from '../../cli/automations/automation-event-trigger-spec'
import { assertCloudTakesTriggers, CI_FINISHED_TRIGGERS_UNSUPPORTED } from './bot-trigger-people'

const ALL = { own: true, github2: true, workflows: true, ciFinished: true }

describe('assertCloudTakesTriggers: github.ci_finished', () => {
  const ciFinished = parseAutomationEventTrigger('github.ci_finished subject=stablyai/orca#482')
  const ciPassed = parseAutomationEventTrigger('github.ci_passed subject=stablyai/orca#482')

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

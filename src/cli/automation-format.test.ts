import { describe, expect, it } from 'vitest'
import { AUTOMATION_ORPHAN_ISSUES } from '../shared/automation-list-scope'
import type { Automation } from '../shared/automations-types'
import { formatAutomationList, formatAutomationShow } from './automation-format'

function automation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'auto-1',
    name: 'Nightly',
    prompt: 'Run checks',
    precheck: null,
    agentId: 'codex',
    projectId: 'repo-legacy',
    executionTargetType: 'ssh',
    executionTargetId: 'box-1',
    schedulerOwner: 'local_host_service',
    workspaceMode: 'new_per_run',
    workspaceId: null,
    baseBranch: null,
    reuseSession: false,
    timezone: 'UTC',
    rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
    dtstart: 0,
    enabled: true,
    nextRunAt: 0,
    missedRunPolicy: 'run_once_within_grace',
    missedRunGraceMinutes: 720,
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

// `orca automations run` sends users to `orca automations show` to find out where
// an automation lives. The stored `executionTarget*` fields survive their host's
// removal untouched, so printing only those renders a dead automation byte-for-byte
// like a healthy one and the named recovery step cannot be completed.
describe('formatAutomationShow reports the host the authority projects', () => {
  it('distinguishes a live SSH host from a replaced one by its incarnation', () => {
    const live = formatAutomationShow({
      automation: automation(),
      owner: { selector: { kind: 'ssh', targetId: 'box-1', targetGeneration: 4 } }
    })
    const replaced = formatAutomationShow({
      automation: automation(),
      owner: { selector: { kind: 'ssh', targetId: 'box-1', targetGeneration: 9 } }
    })

    expect(live).toContain('host: ssh:box-1 (generation 4)')
    expect(replaced).toContain('host: ssh:box-1 (generation 9)')
    expect(live).not.toBe(replaced)
  })

  it('says outright that an orphan has no host, rather than naming its dead target', () => {
    const output = formatAutomationShow({
      automation: automation(),
      owner: { selector: { kind: 'orphan' } }
    })

    expect(output).toContain('host: orphan (no host can run this automation)')
    // The stored pin stays visible; it is the record's history, not its current owner.
    expect(output).toContain('target: ssh:box-1')
  })

  it('names the local host for a self-owned automation', () => {
    const output = formatAutomationShow({
      automation: automation({ executionTargetType: 'local', executionTargetId: 'local' }),
      owner: { selector: { kind: 'self' } }
    })

    expect(output).toContain('host: self')
  })

  // An older authority projects no owner; inventing one from the stored fields would
  // report a removed host as healthy.
  it('omits the host line when the authority reports no owner', () => {
    const output = formatAutomationShow({ automation: automation() })

    expect(output).not.toContain('host:')
    expect(output).toContain('target: ssh:box-1')
  })
})

describe('formatAutomationList reports each row host', () => {
  it('names the orphan issue so the list explains why a row cannot run', () => {
    const output = formatAutomationList({
      automations: [automation(), automation({ id: 'auto-2', name: 'Weekly' })],
      items: [
        {
          automationId: 'auto-1',
          selector: { kind: 'ssh', targetId: 'box-1', targetGeneration: 4 }
        },
        {
          automationId: 'auto-2',
          selector: { kind: 'orphan', issue: AUTOMATION_ORPHAN_ISSUES.targetMissing }
        }
      ]
    })

    expect(output).toContain('host: ssh:box-1 (generation 4)')
    expect(output).toContain(`host: orphan — ${AUTOMATION_ORPHAN_ISSUES.targetMissing}`)
  })

  it('omits the host line for rows an older authority does not qualify', () => {
    const output = formatAutomationList({ automations: [automation()] })

    expect(output).not.toContain('host:')
  })
})

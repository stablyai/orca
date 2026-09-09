// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AutomationListRow } from './AutomationListRow'
import type { Automation } from '../../../../shared/automations-types'
import type { AutomationTargetAvailability } from './automation-target-availability'
import {
  getLocalExecutionHostLabel,
  toRuntimeExecutionHostId
} from '../../../../shared/execution-host'

// Why: act(...) warnings are silenced by opting this module into the React act
// environment, matching how the renderer mounts under test.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Why: Tooltip needs a TooltipProvider mounted higher in the real app; stub the
// primitives so the row renders standalone and the badge trigger stays inspectable.
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

let container: HTMLDivElement
let root: Root

const AVAILABLE: AutomationTargetAvailability = {
  canRunNow: true,
  reason: 'available',
  message: null
}

function makeAutomation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'automation-1',
    name: 'Nightly sync',
    prompt: 'Do the thing',
    precheck: null,
    agentId: 'claude',
    projectId: 'project-1',
    executionTargetType: 'local',
    executionTargetId: 'local',
    schedulerOwner: 'local_host_service',
    workspaceMode: 'existing',
    workspaceId: 'workspace-1',
    baseBranch: null,
    reuseSession: false,
    timezone: 'UTC',
    rrule: 'FREQ=DAILY',
    dtstart: 0,
    enabled: true,
    nextRunAt: 0,
    missedRunPolicy: 'run_once_within_grace',
    missedRunGraceMinutes: 30,
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

type RenderOptions = {
  automation?: Automation
  hostLabelById?: ReadonlyMap<string, string>
}

async function renderRow(options: RenderOptions = {}): Promise<void> {
  const automation = options.automation ?? makeAutomation()
  await act(async () => {
    root.render(
      <AutomationListRow
        automation={automation}
        isSelected={false}
        automationRepo={undefined}
        workspaceLabel="main"
        agentLabel="Claude Code"
        scheduleLabel="Daily"
        usageText="No run usage yet"
        nextRunLabel="Paused"
        runAvailability={AVAILABLE}
        hostLabelById={options.hostLabelById}
        onSelect={vi.fn()}
        onRunNow={vi.fn()}
        onEdit={vi.fn()}
        onToggle={vi.fn()}
        onDelete={vi.fn()}
      />
    )
  })
}

function getBadgeText(): string | null {
  return container.querySelector('[data-slot="badge"]')?.textContent ?? null
}

describe('AutomationListRow', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
  })

  it('renders the automation name and schedule alongside the run-host badge', async () => {
    await renderRow()

    expect(container.textContent).toContain('Nightly sync')
    expect(container.textContent).toContain('Daily')
    expect(getBadgeText()).toBe(getLocalExecutionHostLabel())
  })

  it('shows "Local" when runContext.hostId is unset (defaults to local)', async () => {
    await renderRow({ automation: makeAutomation({ runContext: null }) })

    expect(getBadgeText()).toBe(getLocalExecutionHostLabel())
  })

  it('shows the runtime environment name from hostLabelById when the automation runs on one', async () => {
    const hostId = toRuntimeExecutionHostId('env-42')
    const automation = makeAutomation({
      runContext: {
        kind: 'workspace-run',
        projectId: 'project-1',
        hostId,
        projectHostSetupId: 'setup-1',
        repoId: 'repo-1',
        path: '/repo'
      }
    })
    const hostLabelById = new Map([[hostId, 'Staging box']])

    await renderRow({ automation, hostLabelById })

    expect(getBadgeText()).toBe('Staging box')
  })

  it('falls back to the raw environment id (no crash) when the runtime environment was deleted', async () => {
    const hostId = toRuntimeExecutionHostId('deleted-env')
    const automation = makeAutomation({
      runContext: {
        kind: 'workspace-run',
        projectId: 'project-1',
        hostId,
        projectHostSetupId: 'setup-1',
        repoId: 'repo-1',
        path: '/repo'
      }
    })

    // hostLabelById intentionally omits this environment, and is even omitted
    // entirely here to also cover the caller-didn't-pass-a-map case.
    await renderRow({ automation })

    expect(getBadgeText()).toBe('deleted-env')
  })
})

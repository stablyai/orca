// Layout-owner builds: main gives agent tabs their generated titles from the hook status it owns,
// so a headless server titles them and a window's first frame already shows them.

import { generatedTabTitleForStatus } from '../../../../shared/agent-generated-tab-title-rules'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status-ipc-payload'
import type { AgentStatusOrchestrationContext } from '../../../../shared/agent-status-types'
import { isOrcaDispatchPrompt } from '../../../../shared/agent-row-primary-text'
import type { GeneratedTitleTab } from '../../../../shared/agent-generated-tab-title-rules'
import type {
  GeneratedTabTitle,
  LayoutApplyReply,
  RenameTabsCommand
} from '../../../../shared/workspace-layout/workspace-layout-command-types'

/** The terminal tab main holds for a status's pane, by its tab-bar id. */
export type GeneratedTitleTarget = {
  workspace: string
  tabId: string
  tab: GeneratedTitleTab
}

export type AgentGeneratedTabTitlesDeps = {
  enabled: () => boolean
  targetOf: (row: AgentStatusIpcPayload) => GeneratedTitleTarget | null
  /** Main's dispatch labels by pane key, which a worker's own status may lack. */
  orchestrationByPaneKey: () => Record<string, AgentStatusOrchestrationContext> | undefined
  apply: (command: RenameTabsCommand) => Promise<LayoutApplyReply>
}

export class AgentGeneratedTabTitles {
  private pending: AgentStatusIpcPayload[] = []
  private scheduled = false
  private written: Promise<void> = Promise.resolve()

  constructor(private readonly deps: AgentGeneratedTabTitlesDeps) {}

  noteStatus(row: AgentStatusIpcPayload): void {
    if (row.providerSessionOnly || row.programStatusOnly || !row.prompt) {
      return
    }
    this.pending.push(row)
    if (this.scheduled) {
      return
    }
    this.scheduled = true
    // Why chained: each batch reads the titles the one before it wrote.
    this.written = this.written
      .then(() => this.flush())
      .catch((error) => console.warn('[layout] could not give agent tabs their titles', error))
  }

  /** Resolves once every status noted so far has been written. */
  settled(): Promise<void> {
    return this.written
  }

  private async flush(): Promise<void> {
    this.scheduled = false
    const rows = this.pending
    this.pending = []
    if (!this.deps.enabled()) {
      return
    }
    // Why by tab: a batch's later status reads the title an earlier one gave, as the window's batch does.
    const renames = new Map<string, GeneratedTabTitle>()
    // Read once per batch, and only for a dispatch: it scans every dispatch record.
    const orchestration = rows.some((row) => isOrcaDispatchPrompt(row.prompt))
      ? this.deps.orchestrationByPaneKey()
      : undefined
    for (const row of rows) {
      const target = this.deps.targetOf(row)
      if (!target) {
        continue
      }
      const labels = orchestration?.[row.paneKey] ?? row.orchestration
      const key = `${target.workspace}\0${target.tabId}`
      const earlier = renames.get(key)
      const next = generatedTabTitleForStatus(
        { prompt: row.prompt, orchestration: labels },
        earlier ? { ...target.tab, generatedTitle: earlier.title } : target.tab
      )
      if (!next) {
        continue
      }
      const replaceExisting = next.replaceExisting || earlier?.replaceExisting === true
      renames.set(key, {
        workspace: target.workspace,
        tabId: target.tabId,
        title: next.title,
        ...(replaceExisting ? { replaceExisting: true } : {})
      })
    }
    if (renames.size > 0) {
      // One command: one durable write and one frame for the whole batch.
      await this.deps.apply({
        type: 'renameTabs',
        kind: 'generated',
        renames: [...renames.values()]
      })
    }
  }
}

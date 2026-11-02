import { validatePluginTarget } from '../plugin-authoring/plugin-folder-validation'
import { checkPluginPanels, type PluginPanelCheck } from '../plugin-authoring/plugin-panel-check'

/** `orca plugin check` for one folder, as data: validation errors, else each panel's render. */
export type PluginDevWatchCheckResult = {
  ok: boolean
  /** Manifest problems; panels are not rendered while there are any. */
  invalid: string[]
  panels: PluginPanelCheck[]
}

export async function checkPluginDevFolder(dir: string): Promise<PluginDevWatchCheckResult> {
  const report = await validatePluginTarget(dir)
  if (!report.valid) {
    return { ok: false, invalid: report.errors, panels: [] }
  }
  // Why no tree: a watch prints one line per save; the summary says what drew.
  const panels = (await checkPluginPanels(report.path)).map(({ tree: _tree, ...panel }) => panel)
  return { ok: panels.every((panel) => panel.issues.length === 0), invalid: [], panels }
}

/** Runs checks one at a time: a request while one runs queues a single rerun of the newest code. */
export function createPluginDevWatchCheckQueue(run: () => Promise<void>): {
  request(): void
  idle(): Promise<void>
} {
  let running: Promise<void> | null = null
  let again = false
  const start = (): void => {
    running = run().finally(() => {
      running = null
      if (again) {
        again = false
        start()
      }
    })
  }
  return {
    request: () => {
      if (running) {
        again = true
        return
      }
      start()
    },
    idle: async () => {
      while (running) {
        await running
      }
    }
  }
}

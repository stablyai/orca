/** `unavailable`: nobody can answer (no window, or it is hidden or minimized, or headless). */
export type PluginActionConfirmation = 'allowed' | 'cancelled' | 'unavailable'

/** What tells one automation from another in a question: names repeat, so where and when it runs. */
export type PluginConfirmationAutomation = {
  id: string
  /** As the person sees it in Automations. */
  name: string
  /** Its project's name; null when Orca no longer has the project. */
  project: string | null
  /** The workspace folder each run uses; null when each run creates a workspace. */
  workspace: string | null
  /** Its RRULE or cron line. */
  schedule: string
}

/** What a plugin asks the person to allow; Orca writes the question, so a plugin cannot word it. */
export type PluginConfirmationSubject =
  | {
      kind: 'automation.update'
      automation: PluginConfirmationAutomation
      /** The fields the change touches. */
      fields: readonly ('name' | 'prompt' | 'schedule' | 'timezone' | 'enabled')[]
      /** Its runs use extra agent settings the person chose (arguments, permission mode, precheck). */
      elevated?: true
      /** The new prompt, when the change sets one. */
      prompt?: string
    }
  | { kind: 'automation.delete'; automation: PluginConfirmationAutomation }

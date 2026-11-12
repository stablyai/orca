/** `unavailable`: nobody can answer (no window, or it is hidden or minimized, or headless). */
export type PluginActionConfirmation = 'allowed' | 'cancelled' | 'unavailable'

/** What a plugin asks the person to allow; Orca writes the question, so a plugin cannot word it. */
export type PluginConfirmationSubject =
  | {
      kind: 'automation.update'
      /** The automation's name, as the person sees it in Automations. */
      name: string
      /** The fields the change touches. */
      fields: readonly ('name' | 'prompt' | 'schedule' | 'timezone' | 'enabled')[]
      /** Its runs use extra agent settings the person chose (arguments, permission mode, precheck). */
      elevated?: true
      /** The new prompt, shown when `elevated`. */
      prompt?: string
    }
  | { kind: 'automation.delete'; name: string }

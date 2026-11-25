// The panel ↔ worker contract, declared once: src/panel.tsx and worker/main.mjs both read it.
export {}

declare module 'orca' {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- declaration merging needs an interface
  interface PluginRequests {
    /** The next idea from the `suggestions` setting, skipping titles already on the list. */
    'tasks.suggest': { input: { taken: string[] }; output: { title: string | null } }
  }
  // oxlint-disable-next-line typescript/consistent-type-definitions -- declaration merging needs an interface
  interface PluginPanelEvents {
    /** Posted by the worker when the stored list goes from open tasks to none. */
    'tasks.allDone': { count: number }
  }
}

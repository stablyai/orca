export type QueuedCommand = {
  execute: () => Promise<unknown>
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
}

export type EnqueueTargetedCommandOptions = {
  ensureSession?: boolean
  /** Page actions report what they caused when an agent runs them. */
  reportEffects?: boolean
  // Agent or remote input must not raise the OS file picker. Upload catches the picker itself, and
  // actions without user activation cannot open one.
  blockFileChooser?: boolean
  // Text mutations must not fall back to a global tab from another worktree.
  requireScopedTarget?: boolean
  // Element arguments that may be snapshot refs.
  elements?: readonly (string | undefined)[]
}

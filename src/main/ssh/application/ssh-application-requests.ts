/** Renderer requests the SSH application serves; the desktop adapter registers each one. */
export const SSH_APPLICATION_REQUESTS = [
  'ssh:listTargets',
  'ssh:listRemovedTargetLabels',
  'ssh:addTarget',
  'ssh:updateTarget',
  'ssh:removeTarget',
  'ssh:importConfig',
  'ssh:listConfigHosts',
  'ssh:resolveConfigHost',
  'ssh:connect',
  'ssh:disconnect',
  'ssh:getState',
  'ssh:needsPassphrasePrompt',
  'ssh:testConnection',
  'ssh:addPortForward',
  'ssh:updatePortForward',
  'ssh:removePortForward',
  'ssh:listPortForwards',
  'ssh:listUnrestoredPortForwards',
  'ssh:removeSavedPortForward',
  'ssh:listDetectedPorts'
] as const

export type SshApplicationRequest = (typeof SSH_APPLICATION_REQUESTS)[number]

// oxlint-disable-next-line typescript/no-explicit-any -- SAFETY: Renderer arguments arrive untyped; each operation declares and validates the shape it accepts.
export type SshOperation = (args: any) => unknown

export type RegisterSshRequest = (channel: SshApplicationRequest, operation: SshOperation) => void

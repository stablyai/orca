import type { RuntimePtyController } from './runtime-pty-controller-contract'

type StablePaneCreateScope = Parameters<
  NonNullable<RuntimePtyController['claimStablePaneCreate']>
>[0]

export function claimStablePaneCreate(
  controller: Pick<RuntimePtyController, 'claimStablePaneCreate'>,
  workspace: { id: string; connectionId: StablePaneCreateScope['connectionId'] },
  pane: Pick<StablePaneCreateScope, 'tabId' | 'leafId'>
): () => void {
  const release = controller.claimStablePaneCreate?.({
    worktreeId: workspace.id,
    connectionId: workspace.connectionId,
    ...pane
  })
  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    release?.()
  }
}

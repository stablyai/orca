import type { LocalPtyProvider } from '../providers/local-pty-provider'
import type { RendererLoadKind } from '../window/recovery-reload-intent'

export function handleLocalPtyRendererLoad(
  provider: LocalPtyProvider,
  webContentsId: number,
  classifyRendererLoad?: (webContentsId: number) => RendererLoadKind
): void {
  const generation = provider.advanceGeneration()
  if (classifyRendererLoad?.(webContentsId) !== 'ordinary') {
    return
  }
  provider.killOrphanedPtys(generation - 1)
}

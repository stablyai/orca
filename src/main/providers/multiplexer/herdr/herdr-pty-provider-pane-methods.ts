import type { PtyProviderBufferSnapshot } from '../../types'
import { getHerdrBindingBufferSnapshot, maybeNotifyBlocked } from './herdr-pty-binding-queries'
import {
  moveHerdrPane,
  resizeHerdrPane,
  swapHerdrPane,
  zoomHerdrPane
} from './herdr-pty-provider-layout'
import type { HerdrAgentStatus } from './herdr-runtime-contract'
import type {
  HerdrPaneMoveDestination,
  HerdrPaneMoveResult,
  HerdrPaneSwapOptions,
  HerdrPtyBinding
} from './herdr-pty-types'

export async function bufferSnapshotForBinding(
  bindings: Map<string, HerdrPtyBinding>,
  id: string,
  scrollbackRows?: number
): Promise<PtyProviderBufferSnapshot | null> {
  const binding = bindings.get(id)
  return binding ? getHerdrBindingBufferSnapshot(binding, scrollbackRows) : null
}

export async function zoomPaneForBinding(
  bindings: Map<string, HerdrPtyBinding>,
  id: string,
  mode: 'toggle' | 'on' | 'off' = 'toggle'
): Promise<{ changed: boolean; zoomed: boolean; focused_pane_id: string } | null> {
  const binding = bindings.get(id)
  return binding ? zoomHerdrPane(binding, mode) : null
}

export async function swapPaneForBinding(
  bindings: Map<string, HerdrPtyBinding>,
  id: string,
  params: HerdrPaneSwapOptions
): Promise<{
  changed: boolean
  source_pane_id: string
  target_pane_id: string | null
  focused_pane_id: string
} | null> {
  const binding = bindings.get(id)
  return binding ? swapHerdrPane(binding, params) : null
}

export async function movePaneForBinding(
  bindings: Map<string, HerdrPtyBinding>,
  id: string,
  destination: HerdrPaneMoveDestination,
  focus?: boolean
): Promise<HerdrPaneMoveResult | null> {
  const binding = bindings.get(id)
  return binding ? moveHerdrPane(binding, destination, focus) : null
}

export async function resizePaneForBinding(
  bindings: Map<string, HerdrPtyBinding>,
  id: string,
  direction: 'left' | 'right' | 'up' | 'down',
  amount?: number
): Promise<{ changed: boolean; pane_id: string; focused_pane_id: string } | null> {
  const binding = bindings.get(id)
  return binding ? resizeHerdrPane(binding, direction, amount) : null
}

export async function notifyBlockedForBinding(
  bindings: Map<string, HerdrPtyBinding>,
  id: string,
  agent: string,
  state: HerdrAgentStatus
): Promise<void> {
  const binding = bindings.get(id)
  if (binding) {
    await maybeNotifyBlocked(binding, agent, state)
  }
}

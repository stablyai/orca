import type {
  HerdrPaneMoveDestination,
  HerdrPaneMoveResult,
  HerdrPaneSwapOptions,
  HerdrPtyBinding
} from './herdr-pty-types'
import {
  zoomHerdrBinding,
  swapHerdrBinding,
  moveHerdrBinding,
  resizeHerdrBinding
} from './herdr-pty-binding-queries'

export async function zoomHerdrPane(
  binding: HerdrPtyBinding,
  mode: 'toggle' | 'on' | 'off' = 'toggle'
): Promise<{ changed: boolean; zoomed: boolean; focused_pane_id: string } | null> {
  return await zoomHerdrBinding(binding, mode)
}

export async function swapHerdrPane(
  binding: HerdrPtyBinding,
  params: HerdrPaneSwapOptions
): Promise<{
  changed: boolean
  source_pane_id: string
  target_pane_id: string | null
  focused_pane_id: string
} | null> {
  return await swapHerdrBinding(binding, params)
}

export async function moveHerdrPane(
  binding: HerdrPtyBinding,
  destination: HerdrPaneMoveDestination,
  focus?: boolean
): Promise<HerdrPaneMoveResult | null> {
  return await moveHerdrBinding(binding, { destination, focus })
}

export async function resizeHerdrPane(
  binding: HerdrPtyBinding,
  direction: 'left' | 'right' | 'up' | 'down',
  amount?: number
): Promise<{ changed: boolean; pane_id: string; focused_pane_id: string } | null> {
  return await resizeHerdrBinding(binding, direction, amount)
}

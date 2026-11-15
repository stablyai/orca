export type ZoomTargetType = 'ui' | 'editor' | 'terminal'

export type ZoomLevelChangedEventDetail = {
  type: ZoomTargetType
  percent: number
}

export const ZOOM_LEVEL_CHANGED_EVENT = 'orca:zoom-level-changed'

export function dispatchZoomLevelChanged(type: ZoomTargetType, percent: number): void {
  window.dispatchEvent(
    new CustomEvent<ZoomLevelChangedEventDetail>(ZOOM_LEVEL_CHANGED_EVENT, {
      detail: { type, percent }
    })
  )
}

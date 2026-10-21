import {
  DASHBOARD_MAX_CUSTOM_LANES,
  DASHBOARD_MAX_LANE_LABEL_LENGTH,
  type DashboardLaneAction
} from '../../shared/dashboard-lanes'

const MAX_LANE_ID_LENGTH = 128
const MAX_PANE_KEY_LENGTH = 4_096

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
}

function isLaneId(value: unknown): value is string {
  return isBoundedString(value, MAX_LANE_ID_LENGTH)
}

function isLaneLabel(value: unknown): value is string {
  return isBoundedString(value, DASHBOARD_MAX_LANE_LABEL_LENGTH)
}

export function isDashboardCustomLanes(value: unknown): boolean {
  if (value === undefined) {
    return true
  }
  return (
    Array.isArray(value) &&
    value.length <= DASHBOARD_MAX_CUSTOM_LANES &&
    value.every(
      (lane) =>
        !!lane &&
        typeof lane === 'object' &&
        isLaneId(Reflect.get(lane, 'id')) &&
        isLaneLabel(Reflect.get(lane, 'label'))
    )
  )
}

export function isOptionalDashboardLaneId(value: unknown): boolean {
  return value === undefined || isLaneId(value)
}

/** Lane edits arrive from the pop-out renderer, which has no store; the main
 *  renderer applies them, so only the shape is checked here. */
export function isDashboardLaneAction(value: unknown): value is DashboardLaneAction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const field = (key: string): unknown => Reflect.get(value, key)
  switch (field('kind')) {
    case 'add':
      return isLaneLabel(field('label'))
    case 'rename':
      return isLaneId(field('laneId')) && isLaneLabel(field('label'))
    case 'remove':
      return isLaneId(field('laneId'))
    case 'place':
      return (
        isBoundedString(field('paneKey'), MAX_PANE_KEY_LENGTH) &&
        (field('laneId') === null || isLaneId(field('laneId')))
      )
    default:
      return false
  }
}

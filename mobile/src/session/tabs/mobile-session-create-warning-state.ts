export type MobileSessionCreateWarningState = {
  source: string
  visible: string
}

export function createMobileSessionCreateWarningState(
  source: string
): MobileSessionCreateWarningState {
  return { source, visible: source }
}

export function reconcileMobileSessionCreateWarningState(
  current: MobileSessionCreateWarningState,
  source: string
): MobileSessionCreateWarningState {
  if (current.source === source) {
    return current
  }
  return createMobileSessionCreateWarningState(source)
}

export function dismissMobileSessionCreateWarningState(
  current: MobileSessionCreateWarningState
): MobileSessionCreateWarningState {
  if (!current.visible) {
    return current
  }
  return { ...current, visible: '' }
}

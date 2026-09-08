type MobileWebHardwareBackHandler = () => boolean

let activeHandler: MobileWebHardwareBackHandler | null = null

export function installMobileWebHardwareBackHandler(
  handler: MobileWebHardwareBackHandler
): () => void {
  activeHandler = handler
  return () => {
    if (activeHandler === handler) {
      activeHandler = null
    }
  }
}

export function hasMobileWebHardwareBackHandler(): boolean {
  return activeHandler !== null
}

export function dispatchMobileWebHardwareBack(): boolean {
  try {
    return activeHandler?.() === true
  } catch {
    return false
  }
}

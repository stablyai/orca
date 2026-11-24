/** Recognize iOS/iPadOS WebKit even in desktop mode: Mac user agents alone are ambiguous, so touch points distinguish iPad from Mac. Mobile UAs also contain Mac. */
export function isIosWebPlatform(userAgent: string, maxTouchPoints: number): boolean {
  if (/iPad|iPhone|iPod/.test(userAgent)) {
    return true
  }
  return userAgent.includes('Mac') && maxTouchPoints > 1
}

export function isCurrentPlatformIosWeb(): boolean {
  if (typeof navigator === 'undefined') {
    return false
  }
  return isIosWebPlatform(navigator.userAgent, navigator.maxTouchPoints)
}

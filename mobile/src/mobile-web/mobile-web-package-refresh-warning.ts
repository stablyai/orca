import { mobileWebShellHostName, type MobileWebShellNotice } from './mobile-web-shell-notice'

export function mobileWebPackageRefreshWarning(
  failureCode: string,
  hasHealthyInterface: boolean,
  hostName?: string
): MobileWebShellNotice {
  const host = mobileWebShellHostName(hostName)
  if (failureCode === 'incompatible_bridge') {
    return {
      message: hasHealthyInterface
        ? `Update Orca Mobile to get the latest from ${host}.`
        : `Update Orca Mobile to open ${host}.`,
      code: failureCode
    }
  }
  return {
    message: hasHealthyInterface
      ? `Couldn’t update from ${host}. Showing the last version that worked.`
      : `Couldn’t load ${host}.`,
    code: failureCode
  }
}

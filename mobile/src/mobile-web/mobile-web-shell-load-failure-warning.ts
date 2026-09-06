import type { MobileWebShellNotice } from './mobile-web-shell-notice'

/** Turns a native shell document-load failure code into a notice the hosted shell can show. */
export function mobileWebShellLoadFailureWarning(reason: string | undefined): MobileWebShellNotice {
  if (reason === 'mobile_web_generation_invalid') {
    return { message: 'Couldn’t open the last version that worked.', code: reason }
  }
  if (reason && reason !== 'mobile_web_document_unavailable') {
    return { message: 'Couldn’t open Orca.', code: reason }
  }
  return { message: 'Couldn’t open Orca.', code: reason }
}

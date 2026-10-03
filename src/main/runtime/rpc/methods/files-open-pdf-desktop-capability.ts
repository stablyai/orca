// Transitional: remove once no supported release lacks FILES_PDF_DESKTOP_OPEN_RUNTIME_CAPABILITY.
//
// files.open used to classify a PDF as binary and return opened:false without opening a tab.
// An already-installed mobile client treats opened:true as "activate that tab and files.read it",
// which renders Binary preview unavailable. The desktop viewer stays behind this capability.

import { FILES_PDF_DESKTOP_OPEN_RUNTIME_CAPABILITY } from '../../../../shared/files-pdf-desktop-open-capability'
import type { RpcContext } from '../core'

export function supportsFilesPdfDesktopOpen(
  context: Pick<RpcContext, 'clientKind' | 'clientCapabilities'>
): boolean {
  // An in-process caller is this build. Only a negotiated client can predate the viewer.
  return (
    context.clientKind === undefined ||
    context.clientCapabilities?.includes(FILES_PDF_DESKTOP_OPEN_RUNTIME_CAPABILITY) === true
  )
}
